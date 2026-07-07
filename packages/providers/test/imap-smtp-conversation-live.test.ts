import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationAuthMissing,
  ThreadNotFound,
  TenantId,
  ThreadId,
  type AskCustomerDraft,
  type ConversationReply,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStoreTest,
  type ConnectorConnection,
  type ConversationServiceShape,
} from "@support-agent/services";
import { makeImapSmtpConversation } from "../src/imap-smtp-conversation-live.js";
import type { ImapSmtpOps, RawImapMessage } from "../src/imap-smtp.js";

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");
const mailbox = "support@merchant.com";

const conn = (
  metadata: Readonly<Record<string, unknown>> = {
    imapHost: "imap.x.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.x.com",
    smtpPort: 465,
    smtpSecure: true,
  },
): ConnectorConnection => ({
  tenantId,
  provider: "imap",
  shopDomain: mailbox,
  accessToken: "app-password",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata,
  scopes: [],
  apiVersion: null,
  installedAt: new Date(),
  status: "active",
});

const rawMsg = (over: Partial<RawImapMessage> = {}): RawImapMessage => ({
  uid: 1,
  messageId: "m1@host",
  inReplyTo: null,
  references: [],
  from: { name: "Jane", email: "jane@example.com" },
  to: [{ name: null, email: mailbox }],
  subject: "Order question",
  date: new Date("2026-06-01T10:00:00Z"),
  text: "where is my order",
  html: null,
  ...over,
});

const fakeOps = (over: Partial<ImapSmtpOps> = {}): ImapSmtpOps => ({
  fetchThread: vi.fn(async () => [rawMsg()]),
  listSince: vi.fn(async () => ({ messages: [], latestUid: 0 })),
  latestUid: vi.fn(async () => 0),
  markRead: vi.fn(async () => {}),
  listJunkSince: vi.fn(async () => null),
  latestJunkUid: vi.fn(async () => null),
  markJunkRead: vi.fn(async () => {}),
  send: vi.fn(async () => ({ messageId: "sent-1@host" })),
  verify: vi.fn(async () => {}),
  ...over,
});

const run = <A, E>(
  ops: ImapSmtpOps,
  conns: ReadonlyArray<ConnectorConnection>,
  use: (svc: ConversationServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    makeImapSmtpConversation({ opsFactory: () => ops })
      .pipe(Effect.flatMap((svc) => use(svc)))
      .pipe(Effect.provide(ConnectorCredentialStoreTest(conns))),
  );

describe("makeImapSmtpConversation — fetchThread", () => {
  it("builds a thread from the IMAP search results", async () => {
    const ops = fakeOps();
    const exit = await run(ops, [conn()], (svc) =>
      svc.fetchThread(tenantId, ThreadId("m1@host")),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.messages).toHaveLength(1);
    expect(exit.value.messages[0]!.direction).toBe("inbound");
    expect(ops.fetchThread).toHaveBeenCalledWith("m1@host");
  });

  it("returns ThreadNotFound when the search is empty", async () => {
    const ops = fakeOps({ fetchThread: vi.fn(async () => []) });
    const exit = await run(ops, [conn()], (svc) =>
      svc.fetchThread(tenantId, ThreadId("nope@host")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect((exit.cause as { error?: unknown }).error).toBeInstanceOf(ThreadNotFound);
  });

  it("fails ConversationAuthMissing when no imap connection exists", async () => {
    const exit = await run(fakeOps(), [], (svc) =>
      svc.fetchThread(tenantId, ThreadId("m1@host")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect((exit.cause as { error?: unknown }).error).toBeInstanceOf(
      ConversationAuthMissing,
    );
  });

  it("fails ConversationAuthMissing when host metadata is incomplete", async () => {
    const exit = await run(fakeOps(), [conn({ imapPort: 993 })], (svc) =>
      svc.fetchThread(tenantId, ThreadId("m1@host")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect((exit.cause as { error?: unknown }).error).toBeInstanceOf(
      ConversationAuthMissing,
    );
  });
});

describe("makeImapSmtpConversation — reply / askCustomer", () => {
  const reply: ConversationReply = {
    threadId: ThreadId("m1@host"),
    to: [{ name: "Jane", email: "jane@example.com" }],
    subject: "Re: Order question",
    bodyText: "It shipped yesterday.",
    bodyHtml: null,
    attachments: [],
    inReplyToMessageId: "m1@host",
    draftId: "d-1",
  };

  it("sends with In-Reply-To + References and returns the SMTP message id", async () => {
    const ops = fakeOps();
    const exit = await run(ops, [conn()], (svc) => svc.reply(tenantId, reply));
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.id).toBe("sent-1@host");
    expect(exit.value.threadId).toBe("m1@host");
    // subject + inReplyTo both present → no thread round-trip needed.
    expect(ops.fetchThread).not.toHaveBeenCalled();
    const sendArg = (ops.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendArg.inReplyTo).toBe("m1@host");
    expect(sendArg.references).toEqual(["m1@host"]);
    expect(sendArg.from.email).toBe(mailbox);
    expect(sendArg.idempotencyKey).toBe("d-1");
  });

  it("skips the pre-send read when the subject is already provided", async () => {
    // The reply tool now passes the subject down (derived from the thread it
    // already fetched for the S9 recipient check), so the connector must NOT
    // open a SECOND IMAP connection just to read the same thread. The parent
    // defaults to the thread root → References=[root].
    const send = vi.fn(async () => ({ messageId: "sent-z@host" }));
    const fetchThread = vi.fn(async () => [rawMsg()]);
    const ops = fakeOps({ fetchThread, send });
    const r: ConversationReply = {
      threadId: ThreadId("root@host"),
      to: [{ name: "Jane", email: "jane@example.com" }],
      subject: "Re: Order question",
      bodyText: "It shipped.",
      bodyHtml: null,
      attachments: [],
      inReplyToMessageId: null,
      draftId: "d-skip",
    };
    const exit = await run(ops, [conn()], (svc) => svc.reply(tenantId, r));
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(fetchThread).not.toHaveBeenCalled();
    const sendArg = (send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendArg.subject).toBe("Re: Order question");
    expect(sendArg.references).toEqual(["root@host"]);
    expect(sendArg.inReplyTo).toBeNull();
  });

  it("still sends when the pre-send thread read fails (non-fatal)", async () => {
    // The SMTP send must not be blocked by a flaky IMAP read used only to
    // derive the subject / parent. On a failed read we fall back to a generic
    // subject + References=[root] and still attempt delivery — the reply
    // threads via the recorded message ids regardless.
    const send = vi.fn(async () => ({ messageId: "sent-x@host" }));
    const ops = fakeOps({
      fetchThread: vi.fn(async () => {
        throw new Error("Maximum number of connections exceeded");
      }),
      send,
    });
    const ask: AskCustomerDraft = {
      threadId: ThreadId("root@host"),
      to: [{ name: null, email: "jane@example.com" }],
      subject: null, // forces the pre-send read
      bodyText: "Following up on your order.",
      bodyHtml: null,
      attachments: [],
      draftId: "d-9",
    };
    const exit = await run(ops, [conn()], (svc) =>
      svc.askCustomer(tenantId, ask),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.id).toBe("sent-x@host");
    expect(send).toHaveBeenCalledTimes(1);
    const sendArg = (send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendArg.subject).toBe("Re: support");
    expect(sendArg.references).toEqual(["root@host"]);
    expect(sendArg.inReplyTo).toBeNull();
  });

  it("askCustomer derives In-Reply-To from the latest thread message", async () => {
    const ops = fakeOps({
      fetchThread: vi.fn(async () => [
        rawMsg({ messageId: "m1@host", date: new Date("2026-06-01T00:00:00Z") }),
        rawMsg({
          messageId: "m2@host",
          references: ["m1@host"],
          date: new Date("2026-06-02T00:00:00Z"),
        }),
      ]),
    });
    const ask: AskCustomerDraft = {
      threadId: ThreadId("m1@host"),
      to: [{ name: null, email: "jane@example.com" }],
      subject: null,
      bodyText: "Could you share your order number?",
      bodyHtml: null,
      attachments: [],
      draftId: "d-2",
    };
    const exit = await run(ops, [conn()], (svc) =>
      svc.askCustomer(tenantId, ask),
    );
    expect(exit._tag).toBe("Success");
    expect(ops.fetchThread).toHaveBeenCalled();
    const sendArg = (ops.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // most recent message in the thread becomes the parent
    expect(sendArg.inReplyTo).toBe("m2@host");
    expect(sendArg.references).toEqual(["m1@host", "m2@host"]);
    expect(sendArg.subject).toBe("Re: Order question");
  });
});
