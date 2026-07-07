import { describe, expect, it, vi } from "vitest";
import type { ConnectorConnection } from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  renewOne,
  type RenewalStoreOps,
} from "../src/gmail-watch-renewal.js";

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

const NOW = new Date("2026-05-17T12:00:00.000Z");

const baseConn = (
  overrides: Partial<ConnectorConnection> = {},
): ConnectorConnection => ({
  tenantId: TenantId("11111111-1111-1111-1111-111111111111"),
  provider: "gmail",
  shopDomain: "support@merchant.com",
  accessToken: "live-token",
  refreshToken: "refresh-token",
  tokenExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
  metadata: {
    watchExpiresAt: new Date(NOW.getTime() + 12 * 60 * 60_000).toISOString(),
  },
  scopes: [],
  apiVersion: null,
  installedAt: new Date(),
  status: "active",
  ...overrides,
});

const recordingStore = (): {
  ops: RenewalStoreOps;
  tokens: Array<unknown>;
  metas: Array<unknown>;
} => {
  const tokens: Array<unknown> = [];
  const metas: Array<unknown> = [];
  return {
    tokens,
    metas,
    ops: {
      patchTokens: async (input) => {
        tokens.push(input);
      },
      patchMetadata: async (input) => {
        metas.push(input);
      },
    },
  };
};

const baseDeps = (fetchImpl: typeof fetch) => ({
  google: {
    clientId: "cid",
    clientSecret: "csec",
    pubsubTopic: "projects/p/topics/gmail-inbox",
  },
  fetchImpl,
  now: () => NOW,
});

describe("renewOne — Gmail watch renewal", () => {
  it("renews a connector whose watchExpiresAt is inside the 24h window", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        historyId: "999",
        expiration: String(NOW.getTime() + 7 * 24 * 60 * 60_000),
      }),
    );
    const store = recordingStore();
    const conn = baseConn({
      metadata: {
        watchExpiresAt: new Date(
          NOW.getTime() + 12 * 60 * 60_000,
        ).toISOString(),
      },
    });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("renewed");
    expect(store.tokens).toHaveLength(0); // token still fresh — no refresh needed
    expect(store.metas).toHaveLength(1);
    expect((store.metas[0] as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ historyId: "999" });
  });

  it("skips a connector whose lease is comfortably alive (>24h) and already covers SPAM", async () => {
    const fetchImpl = vi.fn();
    const store = recordingStore();
    const conn = baseConn({
      metadata: {
        watchExpiresAt: new Date(
          NOW.getTime() + 3 * 24 * 60 * 60_000,
        ).toISOString(),
        watchLabelIds: ["INBOX", "SPAM"],
      },
    });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("skipped_not_due");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.metas).toHaveLength(0);
  });

  it("re-registers a healthy lease whose watch predates SPAM coverage", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        historyId: "2000",
        expiration: String(NOW.getTime() + 7 * 24 * 60 * 60_000),
      }),
    );
    const store = recordingStore();
    // Lease comfortably alive, but no watchLabelIds marker — the watch was
    // registered before spam ingestion existed, so it is INBOX-only.
    const conn = baseConn({
      metadata: {
        watchExpiresAt: new Date(
          NOW.getTime() + 3 * 24 * 60 * 60_000,
        ).toISOString(),
      },
    });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("renewed");
    expect(store.metas).toHaveLength(1);
    expect((store.metas[0] as { metadata: Record<string, unknown> }).metadata)
      .toMatchObject({ watchLabelIds: ["INBOX", "SPAM"] });
  });

  it("treats a missing watchExpiresAt as due-for-renewal", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        historyId: "1234",
        expiration: String(NOW.getTime() + 7 * 24 * 60 * 60_000),
      }),
    );
    const store = recordingStore();
    const conn = baseConn({ metadata: {} });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("renewed");
  });

  it("refreshes an expired access token before calling users.watch", async () => {
    const calls: Array<string> = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      if (u.includes("oauth2.googleapis.com/token")) {
        return okJson({
          access_token: "rotated",
          expires_in: 3600,
        });
      }
      return okJson({
        historyId: "h",
        expiration: String(NOW.getTime() + 7 * 24 * 60 * 60_000),
      });
    });
    const store = recordingStore();
    const conn = baseConn({
      tokenExpiresAt: new Date(NOW.getTime() - 60_000), // expired 1min ago
    });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("renewed");
    // Token endpoint hit first, watch endpoint second.
    expect(calls[0]).toContain("oauth2.googleapis.com/token");
    expect(calls[1]).toContain("gmail.googleapis.com/gmail/v1/users/me/watch");
    expect(store.tokens).toHaveLength(1);
    expect((store.tokens[0] as { accessToken: string }).accessToken).toBe(
      "rotated",
    );
  });

  it("skips a connector with no refresh token", async () => {
    const fetchImpl = vi.fn();
    const store = recordingStore();
    const conn = baseConn({ refreshToken: null });

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(result.outcome).toBe("skipped_no_refresh_token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces watch failure as a structured outcome without throwing", async () => {
    const fetchImpl = vi.fn(async () => fail(500, "Internal Server Error"));
    const store = recordingStore();
    const conn = baseConn();

    const result = await renewOne(
      conn,
      baseDeps(fetchImpl as unknown as typeof fetch),
      store.ops,
      NOW,
    );

    expect(typeof result.outcome).toBe("object");
    if (typeof result.outcome === "object") {
      expect(result.outcome.failed).toMatch(/watch:/);
    }
    // No metadata patch on failure.
    expect(store.metas).toHaveLength(0);
  });
});
