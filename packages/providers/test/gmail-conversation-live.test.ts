import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationAuthFailed,
  ConversationAuthMissing,
  TenantId,
  ThreadId,
  type ConversationReply,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConversationService,
} from "@support-agent/services";
import { GmailConversationLive } from "../src/gmail-conversation-live.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: new Headers(),
  }) as unknown as Response;

const b64url = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");

const seededStore = () =>
  Layer.sync(ConnectorCredentialStore, () => {
    const row = {
      tenantId,
      provider: "gmail" as const,
      shopDomain: "support@merchant.com",
      accessToken: "live-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
      metadata: {} as Readonly<Record<string, unknown>>,
      scopes: [] as ReadonlyArray<string>,
      apiVersion: null,
      installedAt: new Date(),
      status: "active" as const,
    };
    return ConnectorCredentialStore.of({
      get: () => Effect.succeed(row),
      put: () => Effect.succeed(row),
      revoke: () => Effect.void,
      listForTenant: () => Effect.succeed([row]),
      patchTokens: (input) =>
        Effect.succeed({
          ...row,
          accessToken: input.accessToken,
          tokenExpiresAt: input.tokenExpiresAt,
        }),
      patchMetadata: (input) =>
        Effect.succeed({
          ...row,
          metadata: { ...row.metadata, ...input.metadata },
        }),
    });
  });

const emptyStore = () =>
  Layer.sync(ConnectorCredentialStore, () =>
    ConnectorCredentialStore.of({
      get: () =>
        Effect.fail(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { _tag: "ConnectorNotFound" } as any,
        ),
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      listForTenant: () => Effect.succeed([]),
      patchTokens: () => Effect.die("unused"),
      patchMetadata: () => Effect.die("unused"),
    }),
  );

describe("GmailConversationLive — fetchThread", () => {
  it("returns a normalised thread when Gmail responds OK", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        id: "t-1",
        messages: [
          {
            id: "m-1",
            threadId: "t-1",
            labelIds: ["INBOX"],
            internalDate: "1747000000000",
            payload: {
              headers: [
                { name: "From", value: "jane@example.com" },
                { name: "To", value: "support@merchant.com" },
                { name: "Subject", value: "Hi" },
              ],
              body: { data: b64url("Hello support") },
            },
          },
        ],
      }),
    );
    const layer = GmailConversationLive({
      clientId: "cid",
      clientSecret: "csec",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));
    const thread = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.fetchThread(tenantId, ThreadId("t-1")),
        ),
        layer,
      ),
    );
    expect(thread.subject).toBe("Hi");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.bodyText).toBe("Hello support");
  });

  it("maps a missing connection to ConversationAuthMissing", async () => {
    const fetchImpl = vi.fn(async () => fail(500));
    const layer = GmailConversationLive({
      clientId: "cid",
      clientSecret: "csec",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(emptyStore()));
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.fetchThread(tenantId, ThreadId("t-1")),
        ),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthMissing);
  });
});

describe("GmailConversationLive — reply", () => {
  it("sends a MIME-encoded reply through users.messages.send and returns SentMessage", async () => {
    const fetchImpl = vi.fn(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        raw: string;
        threadId?: string;
      };
      expect(body.threadId).toBe("t-1");
      const decoded = Buffer.from(
        body.raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      expect(decoded).toContain("From: support@merchant.com");
      expect(decoded).toContain("To: jane@example.com");
      expect(decoded).toContain("In-Reply-To: <prior-msg>");
      expect(decoded).toContain("We shipped yesterday.");
      return okJson({ id: "sent-99", threadId: "t-1" });
    });
    const layer = GmailConversationLive({
      clientId: "cid",
      clientSecret: "csec",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));
    const input: ConversationReply = {
      threadId: ThreadId("t-1"),
      to: [{ name: null, email: "jane@example.com" }],
      subject: "Re: Hi",
      bodyText: "We shipped yesterday.",
      bodyHtml: null,
      attachments: [],
      inReplyToMessageId: "prior-msg",
      draftId: "d-1",
    };
    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) => s.reply(tenantId, input)),
        layer,
      ),
    );
    expect(sent.id).toBe("sent-99");
    expect(sent.threadId).toBe("t-1");
  });

  it("infers reply subject and RFC threading headers from the Gmail thread", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/threads/t-1")) {
        return okJson({
          id: "t-1",
          messages: [
            {
              id: "m-1",
              threadId: "t-1",
              labelIds: ["INBOX"],
              internalDate: "1747000000000",
              payload: {
                headers: [
                  { name: "From", value: "jane@example.com" },
                  { name: "To", value: "support@merchant.com" },
                  { name: "Subject", value: "Product inquiry" },
                  { name: "Message-ID", value: "<m-1@example.com>" },
                ],
                body: { data: "aGk" },
              },
            },
            {
              id: "m-2",
              threadId: "t-1",
              labelIds: ["INBOX"],
              internalDate: "1747000060000",
              payload: {
                headers: [
                  { name: "From", value: "jane@example.com" },
                  { name: "To", value: "support@merchant.com" },
                  { name: "Subject", value: "Product inquiry" },
                  { name: "Message-ID", value: "<m-2@example.com>" },
                ],
                body: { data: "cGluZw" },
              },
            },
          ],
        });
      }

      const body = JSON.parse(String(init.body)) as {
        raw: string;
        threadId?: string;
      };
      expect(body.threadId).toBe("t-1");
      const decoded = Buffer.from(
        body.raw.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8");
      expect(decoded).toContain("Subject: Re: Product inquiry");
      expect(decoded).toContain("In-Reply-To: <m-2@example.com>");
      expect(decoded).toContain(
        "References: <m-1@example.com> <m-2@example.com>",
      );
      return okJson({ id: "sent-100", threadId: "t-1" });
    });

    const layer = GmailConversationLive({
      clientId: "cid",
      clientSecret: "csec",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.reply(tenantId, {
            threadId: ThreadId("t-1"),
            to: [{ name: null, email: "jane@example.com" }],
            subject: null,
            bodyText: "We shipped yesterday.",
            bodyHtml: null,
            attachments: [],
            inReplyToMessageId: null,
            draftId: "d-infer",
          }),
        ),
        layer,
      ),
    );

    expect(sent.id).toBe("sent-100");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps a 401 from Gmail onto ConversationAuthFailed", async () => {
    const fetchImpl = vi.fn(async () => fail(401, "unauthorized"));
    const layer = GmailConversationLive({
      clientId: "cid",
      clientSecret: "csec",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.reply(tenantId, {
            threadId: ThreadId("t-1"),
            to: [{ name: null, email: "jane@example.com" }],
            subject: null,
            bodyText: "hi",
            bodyHtml: null,
            attachments: [],
            inReplyToMessageId: null,
            draftId: "d-2",
          }),
        ),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthFailed);
  });
});
