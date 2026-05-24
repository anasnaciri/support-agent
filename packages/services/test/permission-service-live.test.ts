import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  PermissionService,
  TenantId,
  defineTool,
  type AgentConfig,
} from "@support-agent/agent-core";
import { Schema } from "effect";
import {
  applyRefundPolicy,
  defaultRefundPolicy,
  parseRefundAmount,
  PermissionServiceLive,
  TenantRepositoryTest,
  TenantSettings,
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
  execute: () => Effect.succeed({}),
});

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
): Promise<string> => {
  const tool = toolName === "refund.create" ? refundTool : readTool;
  const tenants = TenantRepositoryTest({
    settingsByTenant: new Map([
      [
        tenantId,
        new TenantSettings({
          notificationEmail: null,
          refundPolicy: policyForTenant,
        }),
      ],
    ]),
  });
  const layer = PermissionServiceLive.pipe(Layer.provide(tenants));
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
    // silently allowing).
    const tenants = TenantRepositoryTest({});
    const layer = PermissionServiceLive.pipe(Layer.provide(tenants));
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
});
