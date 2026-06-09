import { describe, expect, it, vi } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import type { ConnectorConnection } from "@support-agent/services";
import {
  renewOne,
  type GraphRenewalStoreOps,
  type RenewActiveGraphSubscriptionsDeps,
} from "../src/graph-subscription-renewal.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const tenantId = "11111111-1111-1111-1111-111111111111";
const mailbox = "support@merchant.com";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const conn = (
  metadata: Readonly<Record<string, unknown>>,
  over: Partial<ConnectorConnection> = {},
): ConnectorConnection => ({
  tenantId: TenantId(tenantId),
  provider: "outlook",
  shopDomain: mailbox,
  accessToken: "tok",
  refreshToken: "refresh",
  tokenExpiresAt: new Date("2026-06-01T01:00:00Z"),
  metadata,
  scopes: [],
  apiVersion: null,
  installedAt: NOW,
  status: "active",
  ...over,
});

const deps = (fetchImpl: typeof fetch): RenewActiveGraphSubscriptionsDeps => ({
  microsoft: {
    clientId: "c",
    clientSecret: "s",
    tenant: "common",
    notificationUrl: "https://api.example.com/webhooks/conversations/outlook",
    webhookClientState: "secret",
  },
  fetchImpl,
  now: () => NOW,
});

const recordingStore = () => {
  const calls = {
    patchTokens: [] as Array<Record<string, unknown>>,
    patchMetadata: [] as Array<{ metadata: Readonly<Record<string, unknown>> }>,
  };
  const ops: GraphRenewalStoreOps = {
    patchTokens: async (i) => {
      calls.patchTokens.push(i);
    },
    patchMetadata: async (i) => {
      calls.patchMetadata.push(i);
    },
  };
  return { ops, calls };
};

describe("graph-subscription-renewal renewOne", () => {
  it("creates a subscription when the connector has none", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["notificationUrl"]).toBe(
        `https://api.example.com/webhooks/conversations/outlook/${tenantId}`,
      );
      return okJson({ id: "sub-new", expirationDateTime: "2026-06-03T00:00:00Z" });
    }) as unknown as typeof fetch;
    const { ops, calls } = recordingStore();
    const res = await renewOne(conn({}), deps(fetchImpl), ops, NOW);
    expect(res.outcome).toBe("created");
    expect(calls.patchMetadata[0]!.metadata["subscriptionId"]).toBe("sub-new");
  });

  it("renews an existing subscription that is within the window", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-1");
      return okJson({ id: "sub-1", expirationDateTime: "2026-06-03T00:00:00Z" });
    }) as unknown as typeof fetch;
    const { ops } = recordingStore();
    const res = await renewOne(
      conn({
        subscriptionId: "sub-1",
        subscriptionExpiresAt: "2026-06-01T06:00:00Z",
      }),
      deps(fetchImpl),
      ops,
      NOW,
    );
    expect(res.outcome).toBe("renewed");
  });

  it("skips a subscription that is comfortably in lease", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not call Graph for a not-due subscription");
    }) as unknown as typeof fetch;
    const { ops } = recordingStore();
    const res = await renewOne(
      conn({
        subscriptionId: "sub-1",
        subscriptionExpiresAt: "2026-06-10T00:00:00Z",
      }),
      deps(fetchImpl),
      ops,
      NOW,
    );
    expect(res.outcome).toBe("skipped_not_due");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a connector with no refresh token", async () => {
    const fetchImpl = vi.fn(async () => okJson({})) as unknown as typeof fetch;
    const { ops } = recordingStore();
    const res = await renewOne(
      conn({}, { refreshToken: null }),
      deps(fetchImpl),
      ops,
      NOW,
    );
    expect(res.outcome).toBe("skipped_no_refresh_token");
  });
});
