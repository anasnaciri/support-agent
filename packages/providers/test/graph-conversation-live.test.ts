import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationAuthMissing,
  ThreadNotFound,
  TenantId,
  ThreadId,
  type ConversationReply,
} from "@support-agent/agent-core";
import {
  BlobStorageTest,
  ConnectorCredentialStore,
  ConversationService,
} from "@support-agent/services";
import { GraphConversationLive } from "../src/graph-conversation-live.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const noContent = (): Response =>
  ({
    ok: true,
    status: 202,
    json: async () => ({}),
    text: async () => "",
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

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");
const mailbox = "support@merchant.com";

const seededStore = (tokenExpiresAt?: Date) =>
  Layer.sync(ConnectorCredentialStore, () => {
    const row = {
      tenantId,
      provider: "outlook" as const,
      shopDomain: mailbox,
      accessToken: "live-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: tokenExpiresAt ?? new Date(Date.now() + 60 * 60_000),
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
          refreshToken:
            input.refreshToken !== undefined ? input.refreshToken : row.refreshToken,
        }),
      patchMetadata: (input) =>
        Effect.succeed({ ...row, metadata: { ...row.metadata, ...input.metadata } }),
    });
  });

const emptyStore = () =>
  Layer.sync(ConnectorCredentialStore, () =>
    ConnectorCredentialStore.of({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: () => Effect.fail({ _tag: "ConnectorNotFound" } as any),
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      listForTenant: () => Effect.succeed([]),
      patchTokens: () => Effect.die("unused"),
      patchMetadata: () => Effect.die("unused"),
    }),
  );

const conversationList = (messages: ReadonlyArray<unknown>): Response =>
  okJson({ value: messages });

const oneInboundMessage = {
  id: "m-1",
  conversationId: "conv-1",
  subject: "Where is my order?",
  from: { emailAddress: { name: "Jane", address: "jane@example.com" } },
  toRecipients: [{ emailAddress: { address: mailbox } }],
  body: { contentType: "text", content: "Still waiting." },
  receivedDateTime: "2026-06-01T10:00:00Z",
  sentDateTime: "2026-06-01T10:00:00Z",
};

const relayInboundMessage = {
  id: "m-relay",
  conversationId: "conv-1",
  subject: "New contact form submission",
  from: { emailAddress: { name: "Shopify", address: "mailer@shopify.com" } },
  replyTo: [{ emailAddress: { name: "Jane", address: "jane@shopper.com" } }],
  toRecipients: [{ emailAddress: { address: mailbox } }],
  body: { contentType: "text", content: "Where is my order?" },
  receivedDateTime: "2026-06-01T10:00:00Z",
  sentDateTime: "2026-06-01T10:00:00Z",
};

const laterOutboundMessage = {
  id: "m-2",
  conversationId: "conv-1",
  subject: "Re: Where is my order?",
  from: { emailAddress: { name: "Support", address: mailbox } },
  toRecipients: [{ emailAddress: { address: "jane@example.com" } }],
  body: { contentType: "text", content: "We shipped it yesterday." },
  receivedDateTime: "2026-06-01T11:00:00Z",
  sentDateTime: "2026-06-01T11:00:00Z",
};

const runFetchThread = (
  fetchImpl: typeof fetch,
  store: Layer.Layer<ConnectorCredentialStore>,
) =>
  Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(ConversationService, (s) =>
        s.fetchThread(tenantId, ThreadId("conv-1")),
      ),
      GraphConversationLive({
        clientId: "cid",
        clientSecret: "csec",
        fetchImpl,
      }).pipe(Layer.provide(Layer.mergeAll(store, BlobStorageTest({})))),
    ),
  );

describe("GraphConversationLive — fetchThread", () => {
  it("normalises a conversation into a provider-neutral thread", async () => {
    const fetchImpl = vi.fn(async () =>
      conversationList([oneInboundMessage]),
    ) as unknown as typeof fetch;
    const exit = await runFetchThread(fetchImpl, seededStore());
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.subject).toBe("Where is my order?");
    expect(exit.value.messages).toHaveLength(1);
    expect(exit.value.messages[0]!.direction).toBe("inbound");
    expect(exit.value.messages[0]!.bodyText).toBe("Still waiting.");
  });

  it("parses Reply-To and exposes the customer as a thread participant", async () => {
    const fetchImpl = vi.fn(async () =>
      conversationList([relayInboundMessage]),
    ) as unknown as typeof fetch;
    const exit = await runFetchThread(fetchImpl, seededStore());
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    expect(exit.value.messages[0]!.from.email).toBe("mailer@shopify.com");
    expect(exit.value.messages[0]!.replyTo).toEqual({
      name: "Jane",
      email: "jane@shopper.com",
    });
    expect(exit.value.participants.map((p) => p.email)).toContain(
      "jane@shopper.com",
    );
  });

  it("returns ThreadNotFound when the conversation has no messages", async () => {
    const fetchImpl = vi.fn(async () => conversationList([])) as unknown as typeof fetch;
    const exit = await runFetchThread(fetchImpl, seededStore());
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect((exit.cause as { error?: unknown }).error).toBeInstanceOf(ThreadNotFound);
  });

  it("maps a missing connection to ConversationAuthMissing", async () => {
    const fetchImpl = vi.fn(async () => fail(500)) as unknown as typeof fetch;
    const exit = await runFetchThread(fetchImpl, emptyStore());
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect((exit.cause as { error?: unknown }).error).toBeInstanceOf(
      ConversationAuthMissing,
    );
  });

  it("refreshes an expired access token (and uses the rotated one)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("login.microsoftonline.com")) {
        return okJson({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        });
      }
      expect(
        (init?.headers as Record<string, string> | undefined)?.["Authorization"],
      ).toBe("Bearer new-token");
      return conversationList([oneInboundMessage]);
    }) as unknown as typeof fetch;
    const exit = await runFetchThread(
      fetchImpl,
      seededStore(new Date(Date.now() - 1000)),
    );
    expect(exit._tag).toBe("Success");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("login.microsoftonline.com"),
      expect.anything(),
    );
  });
});

describe("GraphConversationLive — reply", () => {
  it("replies to the latest inbound message and explicitly sets customer recipients", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      // After the send, the connector resolves the SENT copy by the
      // internetMessageId the draft was created with. Match on the FILTER,
      // not the substring — `$select` also names internetMessageId.
      if (url.includes(`$filter=${encodeURIComponent("internetMessageId eq")}`)) {
        expect(url).toContain(encodeURIComponent("<imid-9@outlook>"));
        return conversationList([
          { id: "sent-9", isDraft: false, conversationId: "conv-1" },
        ]);
      }
      if (url.includes("/me/messages?$filter")) {
        return conversationList([oneInboundMessage, laterOutboundMessage]);
      }
      if (url.endsWith("/createReply")) {
        expect(url).toContain("/me/messages/m-1/createReply");
        expect(url).not.toContain("/me/messages/m-2/createReply");
        return okJson({
          id: "draft-9",
          conversationId: "conv-1",
          internetMessageId: "<imid-9@outlook>",
        });
      }
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          body: { contentType: string; content: string };
          toRecipients: ReadonlyArray<{
            emailAddress: { name?: string; address: string };
          }>;
        };
        expect(body.body.content).toContain("We shipped it yesterday.");
        expect(body.toRecipients).toEqual([
          {
            emailAddress: {
              name: "Jane",
              address: "jane@example.com",
            },
          },
        ]);
        expect(url).toContain("/me/messages/draft-9");
        return okJson({ id: "draft-9" });
      }
      if (url.endsWith("/send")) return noContent();
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const input: ConversationReply = {
      threadId: ThreadId("conv-1"),
      to: [{ name: "Jane", email: "jane@example.com" }],
      subject: null,
      bodyText: "We shipped it yesterday.",
      bodyHtml: null,
      attachments: [],
      inReplyToMessageId: null,
      draftId: "d-1",
    };

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) => s.reply(tenantId, input)),
        GraphConversationLive({
          clientId: "cid",
          clientSecret: "csec",
          fetchImpl,
        }).pipe(Layer.provide(Layer.mergeAll(seededStore(), BlobStorageTest({})))),
      ),
    );
    // The DRAFT's id is useless downstream: `buildThread` filters drafts out,
    // so nothing that joins on a thread message id can ever match it. Graph
    // moves the item to Sent Items on send and gives it a NEW id; that is the
    // one callers need (e.g. binding a reply's attachments to its bubble).
    expect(sent.id).toBe("sent-9");
    expect(sent.threadId).toBe("conv-1");
  });

  it("falls back to the draft id when the sent copy can't be resolved yet", async () => {
    // Sent Items is eventually consistent. A miss must not fail the send —
    // the reply is already delivered.
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes(`$filter=${encodeURIComponent("internetMessageId eq")}`)) {
        return conversationList([]); // Sent Items hasn't caught up.
      }
      if (url.includes("/me/messages?$filter")) {
        return conversationList([oneInboundMessage]);
      }
      if (url.endsWith("/createReply")) {
        return okJson({
          id: "draft-9",
          conversationId: "conv-1",
          internetMessageId: "<imid-9@outlook>",
        });
      }
      if (method === "PATCH") return okJson({ id: "draft-9" });
      if (url.endsWith("/send")) return noContent();
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) =>
          s.reply(tenantId, {
            threadId: ThreadId("conv-1"),
            to: [{ name: "Jane", email: "jane@example.com" }],
            subject: null,
            bodyText: "We shipped it yesterday.",
            bodyHtml: null,
            attachments: [],
            inReplyToMessageId: null,
            draftId: "d-1",
          }),
        ),
        GraphConversationLive({
          clientId: "cid",
          clientSecret: "csec",
          fetchImpl,
        }).pipe(Layer.provide(Layer.mergeAll(seededStore(), BlobStorageTest({})))),
      ),
    );
    expect(sent.id).toBe("draft-9");
  });

  it("attaches resolved blobs to the draft before sending", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const calls: Array<string> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.includes("/me/messages?$filter")) {
        return conversationList([oneInboundMessage, laterOutboundMessage]);
      }
      if (url.endsWith("/createReply")) {
        calls.push("createReply");
        return okJson({ id: "draft-9", conversationId: "conv-1" });
      }
      if (method === "PATCH") {
        calls.push("patch");
        return okJson({ id: "draft-9" });
      }
      if (url.endsWith("/attachments")) {
        calls.push("attachments");
        const body = JSON.parse(String(init?.body)) as {
          "@odata.type": string;
          name: string;
          contentType: string;
          contentBytes: string;
        };
        expect(body["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
        expect(body.name).toBe("label.pdf");
        expect(body.contentType).toBe("application/pdf");
        expect(body.contentBytes).toBe(Buffer.from(bytes).toString("base64"));
        return okJson({ id: "att-1" });
      }
      if (url.endsWith("/send")) {
        calls.push("send");
        return noContent();
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const input: ConversationReply = {
      threadId: ThreadId("conv-1"),
      to: [{ name: "Jane", email: "jane@example.com" }],
      subject: null,
      bodyText: "Label attached.",
      bodyHtml: null,
      attachments: [
        {
          filename: "label.pdf",
          contentType: "application/pdf",
          storageKey: "upload/t/tk/label.pdf",
          sizeBytes: 3,
        },
      ],
      inReplyToMessageId: null,
      draftId: "d-2",
    };

    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ConversationService, (s) => s.reply(tenantId, input)),
        GraphConversationLive({
          clientId: "cid",
          clientSecret: "csec",
          fetchImpl,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              seededStore(),
              BlobStorageTest({
                seed: {
                  "upload/t/tk/label.pdf": {
                    bytes,
                    contentType: "application/pdf",
                  },
                },
              }),
            ),
          ),
        ),
      ),
    );
    expect(calls).toEqual(["createReply", "patch", "attachments", "send"]);
  });
});
