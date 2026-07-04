import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  ConversationAuthMissing,
  TenantId,
  ThreadId,
  ThreadNotFound,
  type ConversationReply,
  type ConversationThread,
  type SentMessage,
} from "@support-agent/agent-core";
import {
  TicketRepository,
  TicketRepositoryTest,
  ConnectorCredentialStoreTest,
  type ConnectorConnection,
  type ConnectorProvider,
  type ConversationServiceShape,
} from "@support-agent/services";
import {
  makeTicketProviderResolver,
  makeConversationRouter,
  type LegacyThreadProviderResolver,
} from "../src/conversation-router-live.js";

// Audit D2: legacy tickets hold UN-namespaced thread ids (created before
// provider-namespacing). The router must route those by the ticket's stamped
// provider — falling back to the tenant's active conversation connector for
// unstamped rows — instead of failing ThreadNotFound (or, worse, guessing
// "most recent connector" for EVERY thread).

const tenantA = TenantId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

const fakeImpl = (
  name: string,
): ConversationServiceShape & { readonly seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    fetchThread: (_tenantId, threadId) => {
      seen.push(threadId);
      return Effect.succeed({
        id: threadId,
        subject: name,
        participants: [],
        messages: [
          {
            id: `${name}-m1`,
            threadId,
            direction: "inbound",
            from: { name: null, email: "jane@example.com" },
            to: [],
            subject: null,
            bodyText: "hello",
            bodyHtml: null,
            sentAt: new Date(0),
            attachments: [],
          },
        ],
      } satisfies ConversationThread);
    },
    reply: (_tenantId, input) => {
      seen.push(input.threadId);
      return Effect.succeed({
        id: `${name}-sent`,
        threadId: input.threadId,
        sentAt: new Date(0),
      } satisfies SentMessage);
    },
    askCustomer: (_tenantId, input) => {
      seen.push(input.threadId);
      return Effect.succeed({
        id: `${name}-ask`,
        threadId: input.threadId,
        sentAt: new Date(0),
      } satisfies SentMessage);
    },
  };
};

const reply = (threadId: string): ConversationReply => ({
  threadId: ThreadId(threadId),
  to: [{ name: null, email: "jane@example.com" }],
  subject: null,
  bodyText: "hi",
  bodyHtml: null,
  attachments: [],
  inReplyToMessageId: null,
  draftId: "d1",
});

describe("makeConversationRouter — legacy (un-namespaced) thread fallback", () => {
  const setup = (resolved: ConnectorProvider | null) => {
    const gmail = fakeImpl("gmail");
    const outlook = fakeImpl("outlook");
    const calls: string[] = [];
    const resolver: LegacyThreadProviderResolver = (_tenantId, threadId) => {
      calls.push(threadId);
      return Effect.succeed(
        resolved as "gmail" | "outlook" | "imap" | null,
      );
    };
    const router = makeConversationRouter(
      new Map<ConnectorProvider, ConversationServiceShape>([
        ["gmail", gmail],
        ["outlook", outlook],
      ]),
      resolver,
    );
    return { gmail, outlook, router, calls };
  };

  it("routes a legacy id via the resolver, passing the RAW id through", async () => {
    const { gmail, router, calls } = setup("gmail");
    const thread = await Effect.runPromise(
      router.fetchThread(tenantA, ThreadId("19e9ad3a3f896575")),
    );
    expect(calls).toEqual(["19e9ad3a3f896575"]);
    expect(gmail.seen).toEqual(["19e9ad3a3f896575"]);
    // Legacy ids stay un-namespaced on the way out — the stored ticket
    // threadId must keep matching.
    expect(thread.id).toBe("19e9ad3a3f896575");
    expect(thread.messages[0]!.threadId).toBe("19e9ad3a3f896575");
  });

  it("reply on a legacy id keeps the original thread id on the result", async () => {
    const { outlook, router } = setup("outlook");
    const sent = await Effect.runPromise(
      router.reply(tenantA, reply("AAMkADc1Legacy")),
    );
    expect(outlook.seen).toEqual(["AAMkADc1Legacy"]);
    expect(sent.threadId).toBe("AAMkADc1Legacy");
  });

  it("fails ThreadNotFound when the resolver finds no provider", async () => {
    const { router } = setup(null);
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("19e9ad3a3f896575")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ThreadNotFound);
  });

  it("fails ConversationAuthMissing when the resolved provider has no impl", async () => {
    const gmail = fakeImpl("gmail");
    const router = makeConversationRouter(
      new Map<ConnectorProvider, ConversationServiceShape>([["gmail", gmail]]),
      () => Effect.succeed("imap"),
    );
    const exit = await Effect.runPromiseExit(
      router.fetchThread(tenantA, ThreadId("<legacy@x.com>")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthMissing);
  });

  it("namespaced ids still bypass the resolver entirely", async () => {
    const { gmail, router, calls } = setup("outlook");
    await Effect.runPromise(router.fetchThread(tenantA, ThreadId("gmail:t1")));
    expect(calls).toEqual([]);
    expect(gmail.seen).toEqual(["t1"]);
  });
});

describe("makeTicketProviderResolver — ticket stamp first, tenant-level fallback", () => {
  const connection = (
    provider: ConnectorProvider,
    installedAt: Date,
    status: "active" | "revoked" = "active",
  ): ConnectorConnection => ({
    tenantId: tenantA,
    provider,
    shopDomain: `${provider}@example.com`,
    accessToken: "tok",
    refreshToken: null,
    tokenExpiresAt: null,
    metadata: {},
    scopes: [],
    apiVersion: null,
    installedAt,
    status,
  });

  const seedTicket = (threadId: string, provider?: "gmail" | "outlook" | "imap") =>
    Effect.gen(function* () {
      const repo = yield* TicketRepository;
      yield* repo.create({
        tenantId: tenantA,
        channel: "email",
        currentAgentId: AgentId("support-triage"),
        threadId: ThreadId(threadId),
        ...(provider !== undefined ? { provider } : {}),
      });
    });

  it("uses the ticket's stamped provider when present", async () => {
    const program = Effect.gen(function* () {
      yield* seedTicket("legacy-1", "outlook");
      const resolver = yield* makeTicketProviderResolver;
      return yield* resolver(tenantA, ThreadId("legacy-1"));
    }).pipe(
      Effect.provide(
        Layer.merge(TicketRepositoryTest, ConnectorCredentialStoreTest([])),
      ),
    );
    expect(await Effect.runPromise(program)).toBe("outlook");
  });

  it("falls back to the tenant's single active conversation connector", async () => {
    const program = Effect.gen(function* () {
      yield* seedTicket("legacy-2"); // unstamped
      const resolver = yield* makeTicketProviderResolver;
      return yield* resolver(tenantA, ThreadId("legacy-2"));
    }).pipe(
      Effect.provide(
        Layer.merge(
          TicketRepositoryTest,
          ConnectorCredentialStoreTest([
            connection("gmail", new Date("2026-01-01")),
            connection("shopify", new Date("2026-06-01")), // not a conversation connector
          ]),
        ),
      ),
    );
    expect(await Effect.runPromise(program)).toBe("gmail");
  });

  it("tenant-level fallback picks the most recently installed ACTIVE connector", async () => {
    const program = Effect.gen(function* () {
      yield* seedTicket("legacy-3"); // unstamped
      const resolver = yield* makeTicketProviderResolver;
      return yield* resolver(tenantA, ThreadId("legacy-3"));
    }).pipe(
      Effect.provide(
        Layer.merge(
          TicketRepositoryTest,
          ConnectorCredentialStoreTest([
            connection("gmail", new Date("2026-01-01")),
            connection("outlook", new Date("2026-03-01")),
            connection("imap", new Date("2026-05-01"), "revoked"),
          ]),
        ),
      ),
    );
    expect(await Effect.runPromise(program)).toBe("outlook");
  });

  it("returns null when nothing matches", async () => {
    const program = Effect.gen(function* () {
      const resolver = yield* makeTicketProviderResolver;
      return yield* resolver(tenantA, ThreadId("never-seen"));
    }).pipe(
      Effect.provide(
        Layer.merge(TicketRepositoryTest, ConnectorCredentialStoreTest([])),
      ),
    );
    expect(await Effect.runPromise(program)).toBeNull();
  });
});
