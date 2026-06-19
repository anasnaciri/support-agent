import { describe, expect, it, vi } from "vitest";
import { TenantId, type DomainEvent } from "@support-agent/agent-core";
import type { ConnectorConnection } from "@support-agent/services";
import type { ImapSmtpOps, RawImapMessage } from "@support-agent/providers";
import {
  pollOne,
  type ImapPollStoreOps,
  type PollActiveImapDeps,
} from "../src/imap-poll.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const mailbox = "support@merchant.com";

const conn = (
  metadata: Readonly<Record<string, unknown>> = {
    imapHost: "imap.x.com",
    smtpHost: "smtp.x.com",
  },
): ConnectorConnection => ({
  tenantId: TenantId(tenantId),
  provider: "imap",
  shopDomain: mailbox,
  accessToken: "app-pass",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata,
  scopes: [],
  apiVersion: null,
  installedAt: new Date(),
  status: "active",
});

const rawMsg = (over: Partial<RawImapMessage>): RawImapMessage => ({
  uid: 6,
  messageId: "m6@host",
  inReplyTo: null,
  references: [],
  from: { name: "Jane", email: "jane@example.com" },
  to: [{ name: null, email: mailbox }],
  subject: "Order",
  date: new Date("2026-06-01T10:00:00Z"),
  text: "hi",
  html: null,
  ...over,
});

const fakeOps = (over: Partial<ImapSmtpOps> = {}): ImapSmtpOps => ({
  fetchThread: vi.fn(async () => []),
  listSince: vi.fn(async () => ({ messages: [], latestUid: 0 })),
  latestUid: vi.fn(async () => 0),
  markRead: vi.fn(async () => {}),
  send: vi.fn(async () => ({ messageId: "x" })),
  verify: vi.fn(async () => {}),
  ...over,
});

const recordingStore = () => {
  const calls: Array<{ metadata: Readonly<Record<string, unknown>> }> = [];
  const ops: ImapPollStoreOps = {
    patchMetadata: async (i) => {
      calls.push(i);
    },
  };
  return { ops, calls };
};

const depsWith = (
  ops: ImapSmtpOps,
  published: DomainEvent[],
): PollActiveImapDeps => ({
  opsFactory: () => ops,
  publish: async (e) => {
    published.push(e);
  },
});

describe("imap-poll pollOne", () => {
  it("seeds the cursor at the current top of the mailbox on first run", async () => {
    const ops = fakeOps({ latestUid: vi.fn(async () => 7) });
    const published: DomainEvent[] = [];
    const { ops: store, calls } = recordingStore();
    const res = await pollOne(conn(), depsWith(ops, published), store);
    expect(res.outcome).toBe("seeded");
    expect(calls[0]!.metadata["lastUid"]).toBe(7);
    expect(published).toHaveLength(0);
    expect(ops.listSince).not.toHaveBeenCalled();
  });

  it("publishes inbound messages, skips outbound, and advances the cursor", async () => {
    const markRead = vi.fn(async () => {});
    const ops = fakeOps({
      listSince: vi.fn(async () => ({
        messages: [
          rawMsg({
            uid: 6,
            messageId: "m6@host",
            inReplyTo: "root@host",
            references: ["root@host", "m5@host"],
          }),
          rawMsg({
            uid: 7,
            messageId: "m7@host",
            from: { name: null, email: mailbox }, // our own reply
          }),
        ],
        latestUid: 7,
      })),
      markRead,
    });
    const published: DomainEvent[] = [];
    const { ops: store, calls } = recordingStore();
    const res = await pollOne(conn({ imapHost: "i", smtpHost: "s", lastUid: 5 }), depsWith(ops, published), store);
    expect(res.outcome).toEqual({ polled: 1 });
    expect(ops.listSince).toHaveBeenCalledWith(5);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe("message.received");
    // The root is References[0] (the conversation root), not the message's id.
    expect(published[0]!.threadId).toBe("imap:root@host");
    expect(
      (published[0]!.payload as { threadId?: string }).threadId,
    ).toBe("imap:root@host");
    expect(
      (published[0]!.payload as { mailbox?: string }).mailbox,
    ).toBe(mailbox);
    // RFC threading headers flow through so the runtime can correlate the
    // reply to its case via the message-id index.
    expect(
      (published[0]!.payload as { inReplyTo?: string | null }).inReplyTo,
    ).toBe("root@host");
    expect(
      (published[0]!.payload as { references?: ReadonlyArray<string> })
        .references,
    ).toEqual(["root@host", "m5@host"]);
    expect(markRead).toHaveBeenCalledWith([6]);
    expect(calls[0]!.metadata["lastUid"]).toBe(7);
  });

  it("does not advance the cursor when nothing new arrived", async () => {
    const ops = fakeOps({
      listSince: vi.fn(async () => ({ messages: [], latestUid: 5 })),
    });
    const published: DomainEvent[] = [];
    const { ops: store, calls } = recordingStore();
    const res = await pollOne(conn({ imapHost: "i", smtpHost: "s", lastUid: 5 }), depsWith(ops, published), store);
    expect(res.outcome).toEqual({ polled: 0 });
    expect(calls).toHaveLength(0);
  });

  it("still advances the cursor when marking messages read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ops = fakeOps({
      listSince: vi.fn(async () => ({
        messages: [rawMsg({ uid: 6, messageId: "m6@host" })],
        latestUid: 6,
      })),
      markRead: vi.fn(async () => {
        throw new Error("flags unavailable");
      }),
    });
    const published: DomainEvent[] = [];
    const { ops: store, calls } = recordingStore();
    try {
      const res = await pollOne(
        conn({ imapHost: "i", smtpHost: "s", lastUid: 5 }),
        depsWith(ops, published),
        store,
      );
      expect(res.outcome).toEqual({ polled: 1 });
      expect(published).toHaveLength(1);
      expect(calls[0]!.metadata["lastUid"]).toBe(6);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a connector with incomplete host metadata", async () => {
    const ops = fakeOps();
    const published: DomainEvent[] = [];
    const { ops: store } = recordingStore();
    const res = await pollOne(conn({ lastUid: 5 }), depsWith(ops, published), store);
    expect(res.outcome).toBe("skipped_no_config");
    expect(ops.listSince).not.toHaveBeenCalled();
  });
});
