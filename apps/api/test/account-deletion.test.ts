import { describe, expect, it, vi } from "vitest";
import {
  buildConnectorGrants,
  makePgBossAccountCleanupPublisher,
  type ConnectorGrantSource,
} from "../src/account-deletion.js";

const row = (
  overrides: Partial<ConnectorGrantSource> = {},
): ConnectorGrantSource => ({
  provider: "shopify",
  shopDomain: "acme.myshopify.com",
  accessToken: "at",
  refreshToken: null,
  apiVersion: "2025-01",
  status: "active",
  ...overrides,
});

// `enc` is identity-with-a-tag so the test can see what got "encrypted".
const enc = (s: string): string => `ENC(${s})`;

describe("buildConnectorGrants", () => {
  it("captures revoked/disconnected rows too, not just active ones (re-audit #1a)", () => {
    const grants = buildConnectorGrants(
      [
        row({ provider: "shopify", status: "active" }),
        row({ provider: "gmail", shopDomain: "ops@x.com", status: "revoked" }),
      ],
      enc,
    );
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.provider).sort()).toEqual(["gmail", "shopify"]);
    // The locally-revoked row is still included — its provider grant may be live.
    expect(grants.find((g) => g.provider === "gmail")).toBeDefined();
  });

  it("excludes non-OAuth (LLM BYOK) providers", () => {
    const grants = buildConnectorGrants(
      [
        row({ provider: "openrouter" }),
        row({ provider: "anthropic" }),
        row({ provider: "openai" }),
        row({ provider: "shopify" }),
      ],
      enc,
    );
    expect(grants.map((g) => g.provider)).toEqual(["shopify"]);
  });

  it("encrypts both tokens and nulls a missing refresh token", () => {
    const grants = buildConnectorGrants(
      [row({ accessToken: "a", refreshToken: "r" }), row({ refreshToken: null })],
      enc,
    );
    expect(grants[0]).toMatchObject({
      accessTokenEncrypted: "ENC(a)",
      refreshTokenEncrypted: "ENC(r)",
    });
    expect(grants[1]!.refreshTokenEncrypted).toBeNull();
    // Plaintext never appears in the output.
    expect(JSON.stringify(grants)).not.toContain('"a"');
  });

  it("returns an empty list when there are no revocable rows", () => {
    expect(buildConnectorGrants([row({ provider: "openai" })], enc)).toEqual([]);
  });
});

describe("makePgBossAccountCleanupPublisher", () => {
  const data = {
    tenantId: "t1",
    tenantName: "Acme",
    workosOrganizationId: null,
    notificationEmail: null,
  };

  it("returns the job id from boss.send so the caller can verify enqueue (5th-audit #1)", async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      send: vi.fn(async () => "job-123"),
    };
    const publish = makePgBossAccountCleanupPublisher(async () => boss);
    expect(await publish(data)).toBe("job-123");
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it("returns null when boss.send is suppressed (so the caller refuses to wipe)", async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      // A dedup policy returns null when it collapses the send onto an
      // existing job — the API must NOT wipe in that case.
      send: vi.fn(async () => null),
    };
    const publish = makePgBossAccountCleanupPublisher(async () => boss);
    expect(await publish(data)).toBeNull();
  });
});
