import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  CustomerId,
  DiscountFailed,
  OrderId,
  TenantId,
  type ShopifyOrder,
  type ToolContext,
} from "@support-agent/agent-core";
import {
  ShopifyServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  defaultDiscountPolicy,
  defaultRefundPolicy,
  type CreateDiscountCodeInput,
} from "@support-agent/services";
import { shopifyDiscountCreate } from "../src/index.js";

const tenantId = TenantId("t1");
const ctx: ToolContext = {
  tenantId,
  caseId: CaseId("c-1"),
  agentId: AgentId("refund-review-agent"),
  callId: "call_disc_1",
  attemptNumber: 1,
};

const orderId = OrderId("gid://shopify/Order/555");
const customerId = CustomerId("gid://shopify/Customer/777");

const buildOrder = (overrides: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: orderId,
  name: "#1001",
  confirmationNumber: null,
  email: "customer@example.com",
  customerId,
  fulfillmentStatus: "delivered",
  financialStatus: "paid",
  totalPrice: { amount: "40.00", currencyCode: "USD" },
  shippingAddress: null,
  lineItems: [],
  fulfillments: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const settingsWith = (maxValidityDays: number): TenantSettings =>
  new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    discountPolicy: { ...defaultDiscountPolicy, maxValidityDays },
    retentionDays: 730,
    supplierEscalationSheet: null,
    legalAcceptance: null,
  });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Run the tool against a Shopify test layer (optionally capturing the
// CreateDiscountCodeInput the tool builds) and a tenant settings layer.
const run = (
  input: unknown,
  opts: {
    order?: ShopifyOrder | null;
    capture?: (input: CreateDiscountCodeInput) => void;
    failWith?: DiscountFailed;
    settings?: TenantSettings;
  } = {},
) => {
  const order = opts.order === undefined ? buildOrder() : opts.order;
  const shopify = ShopifyServiceTest({
    orders: order ? new Map([[order.id, order]]) : new Map(),
    createDiscountCode: (i) => {
      opts.capture?.(i);
      if (opts.failWith) return Effect.fail(opts.failWith);
      return Effect.succeed({
        id: `gid://shopify/DiscountCodeNode/test-${i.code}`,
        code: i.code,
        title: i.title,
        valueType: i.valueType,
        value: i.value,
        currencyCode: i.currencyCode,
        customerId: i.customerId,
        usageLimit: i.usageLimit,
        endsAt: i.endsAt,
        createdAt: new Date(0),
      });
    },
  });
  const tenants = TenantRepositoryTest(
    opts.settings
      ? { settingsByTenant: new Map([[tenantId, opts.settings]]) }
      : {},
  );
  return Effect.runPromiseExit(
    Effect.provide(
      shopifyDiscountCreate.execute(
        input as never,
        ctx,
      ) as Effect.Effect<unknown, unknown, never>,
      Layer.merge(shopify, tenants),
    ),
  );
};

describe("discount.create tool", () => {
  it("issues a percentage coupon locked to the order's customer with forced guardrails", async () => {
    let captured: CreateDiscountCodeInput | null = null;
    const before = Date.now();
    const exit = await run(
      { orderId, valueType: "percentage", value: "15" },
      { capture: (i) => (captured = i) },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["valueType"]).toBe("percentage");
    expect(result["value"]).toBe("15");
    expect(result["currencyCode"]).toBeNull();
    expect(result["customerId"]).toBe(customerId);
    expect(result["usageLimit"]).toBe(1);
    expect(String(result["code"]).startsWith("THANKS-")).toBe(true);

    // The tool forced the guardrails the agent can't set.
    expect(captured).not.toBeNull();
    const i = captured as unknown as CreateDiscountCodeInput;
    expect(i.usageLimit).toBe(1);
    expect(i.appliesOncePerCustomer).toBe(true);
    expect(i.customerId).toBe(customerId);
    expect(i.currencyCode).toBeNull();
    // endsAt ≈ now + default 30-day window.
    const delta = i.endsAt.getTime() - before;
    expect(delta).toBeGreaterThan(29 * MS_PER_DAY);
    expect(delta).toBeLessThan(31 * MS_PER_DAY);
  });

  it("honors the tenant's maxValidityDays for the expiry window", async () => {
    let captured: CreateDiscountCodeInput | null = null;
    const before = Date.now();
    await run(
      { orderId, valueType: "percentage", value: "10" },
      { capture: (i) => (captured = i), settings: settingsWith(7) },
    );
    const i = captured as unknown as CreateDiscountCodeInput;
    const delta = i.endsAt.getTime() - before;
    expect(delta).toBeGreaterThan(6 * MS_PER_DAY);
    expect(delta).toBeLessThan(8 * MS_PER_DAY);
  });

  it("passes a fixed_amount coupon in the order currency", async () => {
    let captured: CreateDiscountCodeInput | null = null;
    const exit = await run(
      {
        orderId,
        valueType: "fixed_amount",
        value: "5.00",
        currencyCode: "USD",
      },
      { capture: (i) => (captured = i) },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const i = captured as unknown as CreateDiscountCodeInput;
    expect(i.valueType).toBe("fixed_amount");
    expect(i.value).toBe("5.00");
    expect(i.currencyCode).toBe("USD");
  });

  it("rejects a fixed_amount whose currency doesn't match the order", async () => {
    const exit = await run({
      orderId,
      valueType: "fixed_amount",
      value: "5.00",
      currencyCode: "EUR",
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects when the order has no associated customer (can't lock the coupon)", async () => {
    const exit = await run(
      { orderId, valueType: "percentage", value: "10" },
      { order: buildOrder({ customerId: null }) },
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects a percentage above 100", async () => {
    const exit = await run({ orderId, valueType: "percentage", value: "150" });
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("maps a DiscountFailed from the service to a tool error", async () => {
    const exit = await run(
      { orderId, valueType: "percentage", value: "10" },
      {
        failWith: new DiscountFailed({
          code: "DUPLICATE_CODE",
          message: "code already exists",
        }),
      },
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
