import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  ConnectorCredentialStore,
  ConnectorCredentialStoreTest,
  type ConnectorConnection,
} from "@support-agent/services";
import { TenantId, type DomainEvent } from "@support-agent/agent-core";
import {
  handleGraphNotification,
  parseGraphNotifications,
  parseGraphValidationToken,
} from "../graph-webhook.js";
import type { ApiLayer, MicrosoftAppConfig } from "../../../bootstrap.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const mailbox = "support@merchant.com";

const microsoft: MicrosoftAppConfig = {
  clientId: "cid",
  clientSecret: "csec",
  callbackUrl: "https://api.example.com/microsoft/auth/callback",
  tenant: "common",
  notificationUrl: "https://api.example.com/webhooks/conversations/outlook",
  webhookClientState: "shared-secret",
};

const outlookConn: ConnectorConnection = {
  tenantId: TenantId(tenantId),
  provider: "outlook",
  shopDomain: mailbox,
  accessToken: "live-token",
  refreshToken: "refresh-token",
  tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
  metadata: {},
  scopes: [],
  apiVersion: null,
  installedAt: new Date(),
  status: "active",
};

const storeLayer = () =>
  ConnectorCredentialStoreTest([outlookConn]) as unknown as ApiLayer;

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const inboundMessageResponse = okJson({
  id: "m-1",
  conversationId: "conv-1",
  subject: "Where is my order?",
  from: { emailAddress: { name: "Jane", address: "jane@example.com" } },
  toRecipients: [{ emailAddress: { address: mailbox } }],
  body: { contentType: "text", content: "still waiting" },
  sentDateTime: "2026-06-01T10:00:00Z",
});

describe("parseGraphValidationToken", () => {
  it("returns the validationToken from the query", () => {
    expect(parseGraphValidationToken({ validationToken: "abc" })).toBe("abc");
  });
  it("returns null when absent", () => {
    expect(parseGraphValidationToken({})).toBeNull();
  });
});

describe("parseGraphNotifications", () => {
  it("flattens the change-notification envelope", () => {
    const raw = Buffer.from(
      JSON.stringify({
        value: [
          {
            subscriptionId: "sub-1",
            clientState: "shared-secret",
            changeType: "created",
            resource: "/me/messages/m-1",
            resourceData: { id: "m-1" },
          },
        ],
      }),
      "utf8",
    );
    const out = parseGraphNotifications(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      subscriptionId: "sub-1",
      clientState: "shared-secret",
      resourceId: "m-1",
    });
  });
  it("returns [] on malformed JSON", () => {
    expect(parseGraphNotifications(Buffer.from("not json"))).toEqual([]);
  });
});

describe("handleGraphNotification", () => {
  const notification = {
    subscriptionId: "sub-1",
    clientState: "shared-secret",
    resource: "/me/messages/m-1",
    resourceId: "m-1",
    changeType: "created",
  };

  it("fetches the message and publishes message.received for inbound mail", async () => {
    const fetchImpl = vi.fn(async () => inboundMessageResponse) as unknown as typeof fetch;
    const published: DomainEvent[] = [];
    const result = await handleGraphNotification({
      tenantId,
      notifications: [notification],
      layer: storeLayer(),
      microsoft,
      fetchImpl,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(result.published).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe("message.received");
    expect(published[0]!.threadId).toBe("outlook:conv-1");
    expect(
      (published[0]!.payload as { threadId?: string }).threadId,
    ).toBe("outlook:conv-1");
    expect(
      (published[0]!.payload as { mailbox?: string }).mailbox,
    ).toBe(mailbox);
  });

  it("rejects a notification whose clientState does not match", async () => {
    const fetchImpl = vi.fn(async () => inboundMessageResponse) as unknown as typeof fetch;
    const published: DomainEvent[] = [];
    const result = await handleGraphNotification({
      tenantId,
      notifications: [{ ...notification, clientState: "wrong" }],
      layer: storeLayer(),
      microsoft,
      fetchImpl,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(result.rejectedClientState).toBe(1);
    expect(result.published).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("rejects ALL notifications when no webhookClientState is configured — fail closed (audit S4)", async () => {
    const fetchImpl = vi.fn(async () => inboundMessageResponse) as unknown as typeof fetch;
    const published: DomainEvent[] = [];
    const result = await handleGraphNotification({
      tenantId,
      notifications: [notification],
      layer: storeLayer(),
      microsoft: { ...microsoft, webhookClientState: null },
      fetchImpl,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(result.rejectedClientState).toBe(1);
    expect(result.published).toBe(0);
    expect(published).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does no token work for a batch that fails clientState validation (audit S4)", async () => {
    // The connection's token is expired, so any token resolution would
    // trigger a refresh — which goes through fetchImpl. A forged batch
    // (wrong clientState) must be rejected BEFORE any token work, or an
    // unauthenticated POST can churn the tenant's refresh token.
    const expiredConn: ConnectorConnection = {
      ...outlookConn,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    };
    const fetchImpl = vi.fn(async () => inboundMessageResponse) as unknown as typeof fetch;
    const result = await handleGraphNotification({
      tenantId,
      notifications: [{ ...notification, clientState: "wrong" }],
      layer: ConnectorCredentialStoreTest([expiredConn]) as unknown as ApiLayer,
      microsoft,
      fetchImpl,
      publish: async () => {},
    });
    expect(result.rejectedClientState).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks Outlook broken when an expired webhook token cannot refresh", async () => {
    const expiredConn: ConnectorConnection = {
      ...outlookConn,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    };
    const metadataPatches: Array<Record<string, unknown>> = [];
    const layer = Layer.succeed(ConnectorCredentialStore, {
      put: () => Effect.die("put not expected"),
      get: () => Effect.succeed(expiredConn),
      revoke: () => Effect.die("revoke not expected"),
      listForTenant: () => Effect.succeed([expiredConn]),
      patchTokens: () => Effect.die("patchTokens not expected"),
      patchMetadata: (input) =>
        Effect.sync(() => {
          metadataPatches.push({ ...input.metadata });
          return {
            ...expiredConn,
            metadata: { ...expiredConn.metadata, ...input.metadata },
          };
        }),
    });
    const failedRefresh = ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
      json: async () => ({}),
      headers: new Headers(),
    } as unknown) as Response;

    const result = await handleGraphNotification({
      tenantId,
      notifications: [notification],
      layer: layer as unknown as ApiLayer,
      microsoft,
      fetchImpl: (async () => failedRefresh) as unknown as typeof fetch,
      publish: async () => {},
    });

    expect(result.failed).toBe(1);
    expect(metadataPatches).toContainEqual(
      expect.objectContaining({
        connectorHealth: "broken",
        connectorHealthReason: "auth_failed",
      }),
    );
  });

  it("skips a message the mailbox itself sent (outbound)", async () => {
    const outboundResponse = okJson({
      id: "m-2",
      conversationId: "conv-1",
      from: { emailAddress: { address: mailbox } },
      body: { contentType: "text", content: "our reply" },
      sentDateTime: "2026-06-01T11:00:00Z",
    });
    const fetchImpl = vi.fn(async () => outboundResponse) as unknown as typeof fetch;
    const published: DomainEvent[] = [];
    const result = await handleGraphNotification({
      tenantId,
      notifications: [{ ...notification, resourceId: "m-2" }],
      layer: storeLayer(),
      microsoft,
      fetchImpl,
      publish: async (e) => {
        published.push(e);
      },
    });
    expect(result.skippedOutbound).toBe(1);
    expect(published).toHaveLength(0);
  });
});
