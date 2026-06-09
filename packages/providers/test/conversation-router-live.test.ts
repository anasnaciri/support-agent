import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConversationAuthMissing,
  TenantId,
  ThreadId,
  type ConversationReply,
  type ConversationThread,
  type SentMessage,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConnectorCredentialStoreTest,
  type ConnectorConnection,
  type ConnectorProvider,
  type ConversationServiceShape,
} from "@support-agent/services";
import { makeConversationRouter } from "../src/conversation-router-live.js";

const tenantA = TenantId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const tenantB = TenantId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
const tenantC = TenantId("cccccccc-cccc-cccc-cccc-cccccccccccc");

const conn = (
  over: Partial<ConnectorConnection> & {
    readonly tenantId: TenantId;
    readonly provider: ConnectorProvider;
  },
): ConnectorConnection => ({
  shopDomain: "mailbox@example.com",
  accessToken: "tok",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata: {},
  scopes: [],
  apiVersion: null,
  installedAt: new Date("2026-01-01T00:00:00Z"),
  status: "active",
  ...over,
});

// A fake conversation impl that tags every result with its provider name so we
// can assert which connector the router delegated to.
const fakeImpl = (name: string): ConversationServiceShape => ({
  fetchThread: (_tenantId, threadId) =>
    Effect.succeed({
      id: threadId,
      subject: name,
      participants: [],
      messages: [],
    } satisfies ConversationThread),
  reply: (_tenantId, input) =>
    Effect.succeed({
      id: `${name}-sent`,
      threadId: input.threadId,
      sentAt: new Date(0),
    } satisfies SentMessage),
  askCustomer: (_tenantId, input) =>
    Effect.succeed({
      id: `${name}-ask`,
      threadId: input.threadId,
      sentAt: new Date(0),
    } satisfies SentMessage),
});

const impls = new Map<ConnectorProvider, ConversationServiceShape>([
  ["gmail", fakeImpl("gmail")],
  ["outlook", fakeImpl("outlook")],
]);

const replyInput: ConversationReply = {
  threadId: ThreadId("t1"),
  to: [{ name: null, email: "jane@example.com" }],
  subject: null,
  bodyText: "hi",
  bodyHtml: null,
  attachments: [],
  inReplyToMessageId: null,
  draftId: "d1",
};

const runFetch = (tenant: TenantId, seed: ReadonlyArray<ConnectorConnection>) =>
  Effect.runPromiseExit(
    makeConversationRouter(impls)
      .pipe(Effect.flatMap((svc) => svc.fetchThread(tenant, ThreadId("t1"))))
      .pipe(Effect.provide(ConnectorCredentialStoreTest(seed))),
  );

describe("makeConversationRouter", () => {
  it("routes a tenant to its installed gmail connector", async () => {
    const exit = await runFetch(tenantA, [
      conn({ tenantId: tenantA, provider: "gmail" }),
    ]);
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.subject).toBe("gmail");
  });

  it("routes a different tenant to its outlook connector", async () => {
    const exit = await runFetch(tenantB, [
      conn({ tenantId: tenantB, provider: "outlook" }),
    ]);
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.subject).toBe("outlook");
  });

  it("ignores non-conversation connectors (e.g. shopify) when routing", async () => {
    const exit = await Effect.runPromiseExit(
      makeConversationRouter(impls)
        .pipe(Effect.flatMap((svc) => svc.reply(tenantA, replyInput)))
        .pipe(
          Effect.provide(
            ConnectorCredentialStoreTest([
              conn({ tenantId: tenantA, provider: "shopify" }),
              conn({ tenantId: tenantA, provider: "gmail" }),
            ]),
          ),
        ),
    );
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.id).toBe("gmail-sent");
  });

  it("prefers the most recently installed conversation connector", async () => {
    const exit = await runFetch(tenantA, [
      conn({
        tenantId: tenantA,
        provider: "gmail",
        installedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      conn({
        tenantId: tenantA,
        provider: "outlook",
        installedAt: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.subject).toBe("outlook");
  });

  it("skips revoked connectors", async () => {
    const exit = await runFetch(tenantA, [
      conn({
        tenantId: tenantA,
        provider: "outlook",
        status: "revoked",
        installedAt: new Date("2026-03-01T00:00:00Z"),
      }),
      conn({
        tenantId: tenantA,
        provider: "gmail",
        installedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") expect(exit.value.subject).toBe("gmail");
  });

  it("fails with ConversationAuthMissing when the tenant has no conversation connector", async () => {
    const exit = await runFetch(tenantC, [
      conn({ tenantId: tenantC, provider: "shopify" }),
    ]);
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthMissing);
  });

  it("ignores a conversation connector with no installed impl", async () => {
    // Tenant installed outlook but the router was built with only gmail.
    const gmailOnly = new Map<ConnectorProvider, ConversationServiceShape>([
      ["gmail", fakeImpl("gmail")],
    ]);
    const exit = await Effect.runPromiseExit(
      makeConversationRouter(gmailOnly)
        .pipe(Effect.flatMap((svc) => svc.fetchThread(tenantB, ThreadId("t1"))))
        .pipe(
          Effect.provide(
            ConnectorCredentialStoreTest([
              conn({ tenantId: tenantB, provider: "outlook" }),
            ]),
          ),
        ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const err = (exit.cause as { error?: unknown }).error;
    expect(err).toBeInstanceOf(ConversationAuthMissing);
  });
});
