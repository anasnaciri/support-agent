import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  PermissionService,
  TenantId,
  defineTool,
  type AgentConfig,
  type AnyTool,
} from "@support-agent/agent-core";
import { Schema } from "effect";
import {
  applyRefundPolicy,
  checkRequiredScopes,
  ConnectorCredentialStoreTest,
  defaultRefundPolicy,
  parseRefundAmount,
  PermissionServiceLive,
  TenantRepositoryTest,
  TenantSettings,
  type ConnectorConnection,
  type RefundPolicy,
} from "../src/index.js";

// ============================================================
// Pure-function tests — applyRefundPolicy + parseRefundAmount
// ============================================================

const policy: RefundPolicy = {
  askAboveMinorUnits: 2500, // $25
  denyAboveMinorUnits: 20000, // $200
  currencyCode: "USD",
};

describe("parseRefundAmount", () => {
  it("parses a well-formed refund payload", () => {
    expect(
      parseRefundAmount({
        orderId: "gid://shopify/Order/1",
        amount: { amount: "29.99", currencyCode: "usd" },
      }),
    ).toEqual({ amountMinorUnits: 2999, currencyCode: "USD" });
  });

  it("rounds to nearest cent (no float drift)", () => {
    // 19.995 * 100 = 1999.5 → rounds to 2000 (banker's-style ties matter
    // less than reproducibility here; just check Math.round behavior).
    expect(parseRefundAmount({ amount: { amount: "19.99", currencyCode: "USD" } }))
      .toEqual({ amountMinorUnits: 1999, currencyCode: "USD" });
  });

  it("returns null on malformed payloads", () => {
    expect(parseRefundAmount(null)).toBeNull();
    expect(parseRefundAmount({})).toBeNull();
    expect(parseRefundAmount({ amount: "29.99" })).toBeNull();
    expect(parseRefundAmount({ amount: { currencyCode: "USD" } })).toBeNull();
    expect(
      parseRefundAmount({ amount: { amount: "abc", currencyCode: "USD" } }),
    ).toBeNull();
    expect(
      parseRefundAmount({ amount: { amount: "-5.00", currencyCode: "USD" } }),
    ).toBeNull();
  });
});

describe("applyRefundPolicy", () => {
  it("returns the static permission when amount is malformed", () => {
    expect(applyRefundPolicy("ask", policy, null)).toBe("ask");
    expect(applyRefundPolicy("allow", policy, null)).toBe("allow");
    expect(applyRefundPolicy("deny", policy, null)).toBe("deny");
  });

  it("downgrades to ask on currency mismatch (never auto-allows)", () => {
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 100,
        currencyCode: "EUR",
      }),
    ).toBe("ask");
    expect(
      applyRefundPolicy("allow", policy, {
        amountMinorUnits: 100,
        currencyCode: "EUR",
      }),
    ).toBe("ask");
    // Existing `deny` is preserved across the mismatch.
    expect(
      applyRefundPolicy("deny", policy, {
        amountMinorUnits: 100,
        currencyCode: "EUR",
      }),
    ).toBe("deny");
  });

  it("auto-allows when amount is at or below askAbove", () => {
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 0,
        currencyCode: "USD",
      }),
    ).toBe("allow");
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 2500,
        currencyCode: "USD",
      }),
    ).toBe("allow");
  });

  it("asks in the mid zone (askAbove < amount ≤ denyAbove)", () => {
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 2501,
        currencyCode: "USD",
      }),
    ).toBe("ask");
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 20000,
        currencyCode: "USD",
      }),
    ).toBe("ask");
  });

  it("denies above the hard cap", () => {
    expect(
      applyRefundPolicy("ask", policy, {
        amountMinorUnits: 20001,
        currencyCode: "USD",
      }),
    ).toBe("deny");
    // Even when the agent override said `allow`, the hard cap wins.
    expect(
      applyRefundPolicy("allow", policy, {
        amountMinorUnits: 50000,
        currencyCode: "USD",
      }),
    ).toBe("deny");
  });

  it("never relaxes a static `deny`", () => {
    expect(
      applyRefundPolicy("deny", policy, {
        amountMinorUnits: 100,
        currencyCode: "USD",
      }),
    ).toBe("deny");
  });
});

// ============================================================
// Layer integration — full PermissionServiceLive end-to-end
// ============================================================

const tenantId = TenantId("00000000-0000-0000-0000-000000000001");

const refundTool = defineTool({
  name: "refund.create",
  description: "stub",
  inputSchema: Schema.Struct({
    orderId: Schema.String,
    amount: Schema.Struct({
      amount: Schema.String,
      currencyCode: Schema.String,
    }),
  }),
  outputSchema: Schema.Struct({}),
  risk: "money",
  defaultPermission: "ask",
  sideEffectClass: "financial",
  // Mirrors the real refund.create declaration so the layer-integration
  // tests below exercise the scope precheck end-to-end.
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["write_orders"],
  },
  execute: () => Effect.succeed({}),
});

// Active Shopify connection with write_orders — the "everything granted"
// fixture for tests that DON'T want the scope precheck to fire.
const shopifyConnectionWithRefunds: ConnectorConnection = {
  tenantId,
  provider: "shopify",
  shopDomain: "test-shop.myshopify.com",
  accessToken: "shpat_test",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata: {},
  scopes: ["read_orders", "read_customers", "write_orders"],
  apiVersion: "2026-04",
  installedAt: new Date(),
  status: "active",
};

const readTool = defineTool({
  name: "shopify.get_order",
  description: "stub",
  inputSchema: Schema.Struct({ orderId: Schema.String }),
  outputSchema: Schema.Struct({}),
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: () => Effect.succeed({}),
});

const agent: AgentConfig = {
  id: AgentId("refund-review-agent"),
  name: "Refund Review",
  description: "stub",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: "stub",
  tools: ["refund.create", "shopify.get_order"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 6,
  temperature: 0,
};

const runCheck = async (
  toolName: string,
  payload: unknown,
  policyForTenant: RefundPolicy,
  connections: ReadonlyArray<ConnectorConnection> = [
    shopifyConnectionWithRefunds,
  ],
): Promise<string> => {
  const tool = toolName === "refund.create" ? refundTool : readTool;
  const tenants = TenantRepositoryTest({
    settingsByTenant: new Map([
      [
        tenantId,
        new TenantSettings({
          notificationEmail: null,
          refundPolicy: policyForTenant,
          retentionDays: 730,
        }),
      ],
    ]),
  });
  const connectors = ConnectorCredentialStoreTest(connections);
  const layer = PermissionServiceLive.pipe(
    Layer.provide(Layer.mergeAll(tenants, connectors)),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* PermissionService;
        return yield* svc.check({ tenantId, agent, tool, payload });
      }),
      layer,
    ),
  );
};

describe("PermissionServiceLive", () => {
  it("auto-allows a $20 refund when askAbove=$25 (read fall-through)", async () => {
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        amount: { amount: "20.00", currencyCode: "USD" },
      },
      policy,
    );
    expect(result).toBe("allow");
  });

  it("asks on a $100 refund (mid-range)", async () => {
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        amount: { amount: "100.00", currencyCode: "USD" },
      },
      policy,
    );
    expect(result).toBe("ask");
  });

  it("denies a $500 refund (above hard cap)", async () => {
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        amount: { amount: "500.00", currencyCode: "USD" },
      },
      policy,
    );
    expect(result).toBe("deny");
  });

  it("does NOT touch non-refund tools (passes through static rule)", async () => {
    const result = await runCheck(
      "shopify.get_order",
      { orderId: "#1001" },
      policy,
    );
    // shopify.get_order's defaultPermission is "allow"; no conditional
    // rule fires.
    expect(result).toBe("allow");
  });

  it("falls back to defaultRefundPolicy when the tenant row is missing", async () => {
    // No tenant rows in the Test fixture → getSettings fails → the
    // Live layer's defensive fallback kicks in. defaultRefundPolicy has
    // askAbove=0 so EVERY refund pauses for approval (safer than
    // silently allowing). We still pass the granted-scope connection so
    // the precheck doesn't pre-empt the threshold logic.
    const tenants = TenantRepositoryTest({});
    const connectors = ConnectorCredentialStoreTest([
      shopifyConnectionWithRefunds,
    ]);
    const layer = PermissionServiceLive.pipe(
      Layer.provide(Layer.mergeAll(tenants, connectors)),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* PermissionService;
          return yield* svc.check({
            tenantId,
            agent,
            tool: refundTool,
            payload: {
              orderId: "gid://shopify/Order/1",
              amount: { amount: "1.00", currencyCode: "USD" },
            },
          });
        }),
        layer,
      ),
    );
    // defaultRefundPolicy: askAbove=0, so $1 > 0 → ask.
    expect(result).toBe("ask");
    expect(defaultRefundPolicy.askAboveMinorUnits).toBe(0);
  });

  it("denies refund.create when the Shopify connection lacks write_orders", async () => {
    // Active Shopify row but only `read_orders` granted — the precheck
    // fires BEFORE the threshold logic and denies regardless of amount.
    const readOnlyShopify: ConnectorConnection = {
      ...shopifyConnectionWithRefunds,
      scopes: ["read_orders", "read_customers"],
    };
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        // $1 — well below askAbove=$25 — would auto-allow if scopes
        // were granted; instead the precheck denies.
        amount: { amount: "1.00", currencyCode: "USD" },
      },
      policy,
      [readOnlyShopify],
    );
    expect(result).toBe("deny");
  });

  it("denies refund.create when there is no active Shopify connection", async () => {
    // Revoked row → no active connection on the provider → deny.
    const revoked: ConnectorConnection = {
      ...shopifyConnectionWithRefunds,
      status: "revoked",
    };
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        amount: { amount: "10.00", currencyCode: "USD" },
      },
      policy,
      [revoked],
    );
    expect(result).toBe("deny");
  });

  it("denies refund.create when the tenant has zero connector rows", async () => {
    const result = await runCheck(
      "refund.create",
      {
        orderId: "gid://shopify/Order/1",
        amount: { amount: "10.00", currencyCode: "USD" },
      },
      policy,
      [],
    );
    expect(result).toBe("deny");
  });

  it("does NOT fire the precheck for tools without requiredConnectorScopes", async () => {
    // shopify.get_order declares no scope requirement → the precheck is
    // a no-op even when there's no Shopify connection at all.
    const result = await runCheck(
      "shopify.get_order",
      { orderId: "#1001" },
      policy,
      [],
    );
    expect(result).toBe("allow");
  });
});

// ============================================================
// Pure-function tests — checkRequiredScopes
// ============================================================

describe("checkRequiredScopes", () => {
  const tool: AnyTool = {
    ...refundTool,
  } as never;

  const connection: ConnectorConnection = {
    tenantId,
    provider: "shopify",
    shopDomain: "test-shop.myshopify.com",
    accessToken: "shpat_test",
    refreshToken: null,
    tokenExpiresAt: null,
    metadata: {},
    scopes: ["read_orders", "write_orders"],
    apiVersion: null,
    installedAt: new Date(),
    status: "active",
  };

  it("returns ok when the active connection has every required scope", () => {
    expect(checkRequiredScopes(tool, [connection])).toBe("ok");
  });

  it("returns ok when the tool declares no scope requirement", () => {
    const stubTool = { ...tool, requiredConnectorScopes: undefined };
    expect(checkRequiredScopes(stubTool as never, [])).toBe("ok");
  });

  it("returns missing when no active connection matches the provider", () => {
    expect(checkRequiredScopes(tool, [])).toBe("missing");
    expect(
      checkRequiredScopes(tool, [{ ...connection, status: "revoked" }]),
    ).toBe("missing");
    expect(
      checkRequiredScopes(tool, [{ ...connection, provider: "gmail" }]),
    ).toBe("missing");
  });

  it("returns missing when the active connection lacks a required scope", () => {
    expect(
      checkRequiredScopes(tool, [
        { ...connection, scopes: ["read_orders"] }, // no write_orders
      ]),
    ).toBe("missing");
  });
});
