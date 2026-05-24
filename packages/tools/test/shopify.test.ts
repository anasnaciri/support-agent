import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  CustomerId,
  OrderId,
  RefundFailed,
  ShopifyAuthMissing,
  TenantId,
  ToolOutputInvalid,
  type ShopifyCustomer,
  type ShopifyError,
  type ShopifyOrder,
  type ToolContext,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import {
  shopifyGetCustomer,
  shopifyGetOrder,
  shopifyRefundCreate,
} from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (caseId: string): ToolContext => ({
  tenantId,
  caseId: CaseId(caseId),
  agentId: AgentId("support-triage"),
  callId: "call_1",
  attemptNumber: 1,
});

const buildOrder = (id: string): ShopifyOrder => ({
  id: OrderId(id),
  name: "#1001",
  email: "customer@example.com",
  customerId: CustomerId("gid://shopify/Customer/777"),
  fulfillmentStatus: "in_transit",
  financialStatus: "paid",
  totalPrice: { amount: "29.99", currencyCode: "USD" },
  shippingAddress: {
    name: "Jane Doe",
    address1: "123 Main",
    address2: null,
    city: "Brooklyn",
    province: "NY",
    country: "US",
    zip: "11201",
    phone: null,
  },
  lineItems: [
    {
      id: "li-1",
      title: "Mug",
      quantity: 2,
      sku: "MUG-01",
      variantTitle: null,
    },
  ],
  fulfillments: [
    {
      id: "f-1",
      status: "in_transit",
      trackingCompany: "UPS",
      trackingNumbers: ["1Z999"],
      trackingUrls: ["https://wwwapps.ups.com/tracking?t=1Z999"],
      estimatedDeliveryAt: new Date("2026-05-20T00:00:00.000Z"),
      deliveredAt: null,
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
    },
  ],
  createdAt: new Date("2026-05-14T00:00:00.000Z"),
  updatedAt: new Date("2026-05-15T00:00:00.000Z"),
});

describe("shopify.get_order tool", () => {
  it("returns a flattened order payload on success (by GID)", async () => {
    const orderId = OrderId("gid://shopify/Order/12345");
    const env = ShopifyServiceTest({
      orders: new Map([[orderId, buildOrder(orderId)]]),
    });

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId } as never,
          baseCtx("c-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["id"]).toBe(orderId);
    expect(result["name"]).toBe("#1001");
    expect(result["fulfillmentStatus"]).toBe("in_transit");
    expect((result["lineItems"] as ReadonlyArray<unknown>)[0]).toMatchObject({
      title: "Mug",
      quantity: 2,
      sku: "MUG-01",
    });
    const fulfillments = result["fulfillments"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(fulfillments[0]!["status"]).toBe("in_transit");
    expect(
      (fulfillments[0]!["tracking"] as Record<string, unknown>)["numbers"],
    ).toEqual(["1Z999"]);
    // Dates are stringified to ISO.
    expect(fulfillments[0]!["estimatedDeliveryAt"]).toBe(
      "2026-05-20T00:00:00.000Z",
    );
  });

  // Regression for the 2026-05-16 live demo: customers reference orders
  // by name (`#1001`), not internal id. The tool must dispatch non-GID
  // input through `findOrderByName`, not synthesize a fake GID.
  it("dispatches non-GID input through findOrderByName (name lookup)", async () => {
    const order = buildOrder("gid://shopify/Order/12098337702252");
    const env = ShopifyServiceTest({
      ordersByName: new Map([["#1001", order]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "#1001" } as never,
          baseCtx("c-name"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect((exit.value as Record<string, unknown>)["name"]).toBe("#1001");
  });

  it("accepts a bare name (no `#`) and still resolves through findOrderByName", async () => {
    const order = buildOrder("gid://shopify/Order/12098337702252");
    const env = ShopifyServiceTest({
      ordersByName: new Map([["#1001", order]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "1001" } as never,
          baseCtx("c-bare"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect((exit.value as Record<string, unknown>)["name"]).toBe("#1001");
  });

  it("maps a null findOrderByName result to ToolOutputInvalid OrderNotFound", async () => {
    // The ordersByName map is empty → findOrderByName returns null →
    // the tool MUST map that to ToolOutputInvalid, not silently succeed
    // with null and crash the output-schema decode at the runtime boundary.
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "#9999" } as never,
          baseCtx("c-miss"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.get_order");
        expect(err.issues).toEqual(["OrderNotFound"]);
      }
    }
  });

  it("maps OrderNotFound to ToolOutputInvalid", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "gid://shopify/Order/missing" } as never,
          baseCtx("c-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.get_order");
        expect(err.issues).toEqual(["OrderNotFound"]);
      }
    }
  });

  it("propagates ShopifyAuthMissing through the tool boundary on get_order", async () => {
    // ShopifyServiceTest never fails with auth-missing — we build a tiny
    // alternate layer that does, to assert the error mapping works end-to-end.
    const env = Layer.succeed(
      // Use the same Tag we know the tool yields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@support-agent/services")).ShopifyService as any,
      {
        getOrder: () =>
          Effect.fail(new ShopifyAuthMissing({ tenantId })),
      },
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "gid://shopify/Order/1" } as never,
          baseCtx("c-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual(["ShopifyAuthMissing"]);
      }
    }
  });
});

const buildCustomer = (id: string, email: string | null): ShopifyCustomer => ({
  id: CustomerId(id),
  email,
  firstName: "Jane",
  lastName: "Doe",
  phone: "+15555550100",
  ordersCount: 4,
  totalSpent: { amount: "129.96", currencyCode: "USD" },
  defaultAddress: {
    name: "Jane Doe",
    address1: "123 Main",
    address2: null,
    city: "Brooklyn",
    province: "NY",
    country: "US",
    zip: "11201",
    phone: null,
  },
  createdAt: new Date("2025-01-02T03:04:05.000Z"),
});

describe("shopify.get_customer tool", () => {
  it("returns a flattened customer payload on lookup by id", async () => {
    const customerId = CustomerId("gid://shopify/Customer/777");
    const env = ShopifyServiceTest({
      customers: new Map([[customerId, buildCustomer(customerId, "j@d.com")]]),
    });

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetCustomer.execute(
          { customerId } as never,
          baseCtx("c-cust-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["id"]).toBe(customerId);
    expect(result["email"]).toBe("j@d.com");
    expect(result["ordersCount"]).toBe(4);
    expect(result["createdAt"]).toBe("2025-01-02T03:04:05.000Z");
    expect((result["totalSpent"] as Record<string, unknown>)["amount"]).toBe(
      "129.96",
    );
    expect((result["defaultAddress"] as Record<string, unknown>)["city"]).toBe(
      "Brooklyn",
    );
  });

  it("returns a flattened customer payload on lookup by email", async () => {
    const customerId = CustomerId("gid://shopify/Customer/888");
    const env = ShopifyServiceTest({
      customersByEmail: new Map([
        ["jane@example.com", buildCustomer(customerId, "jane@example.com")],
      ]),
    });

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetCustomer.execute(
          { email: "jane@example.com" } as never,
          baseCtx("c-cust-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["id"]).toBe(customerId);
    expect(result["email"]).toBe("jane@example.com");
  });

  it("rejects with ToolOutputInvalid when both customerId and email are provided", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetCustomer.execute(
          { customerId: "gid://shopify/Customer/1", email: "x@y.com" } as never,
          baseCtx("c-cust-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual(["exactly_one_of_customerId_email"]);
      }
    }
  });

  it("rejects with ToolOutputInvalid when neither customerId nor email is provided", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetCustomer.execute(
          {} as never,
          baseCtx("c-cust-4"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual(["exactly_one_of_customerId_email"]);
      }
    }
  });

  it("maps a null searchByEmail result to ToolOutputInvalid CustomerNotFound", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetCustomer.execute(
          { email: "nobody@example.com" } as never,
          baseCtx("c-cust-5"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.get_customer");
        expect(err.issues).toEqual(["CustomerNotFound"]);
      }
    }
  });
});

describe("refund.create tool", () => {
  it("returns a flattened refund payload on success", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyRefundCreate.execute(
          {
            orderId: "gid://shopify/Order/12345",
            amount: { amount: "29.99", currencyCode: "USD" },
            reason: "Customer-requested refund",
            notifyCustomer: true,
          } as never,
          baseCtx("c-refund-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["orderId"]).toBe("gid://shopify/Order/12345");
    expect((result["amount"] as Record<string, unknown>)["amount"]).toBe(
      "29.99",
    );
    expect((result["amount"] as Record<string, unknown>)["currencyCode"]).toBe(
      "USD",
    );
    expect(result["note"]).toBe("Customer-requested refund");
    // The default Test impl returns a deterministic id; we just assert
    // the field is present and non-empty.
    expect(typeof result["id"]).toBe("string");
    expect((result["id"] as string).length).toBeGreaterThan(0);
    // createdAt is an ISO string.
    expect(typeof result["createdAt"]).toBe("string");
  });

  it("maps RefundFailed to ToolOutputInvalid with the tag in issues", async () => {
    const env = ShopifyServiceTest({
      refundOrder: () =>
        Effect.fail(
          new RefundFailed({
            orderId: "gid://shopify/Order/12345",
            code: "NO_REFUNDABLE_TRANSACTION",
            message: "No refundable SALE/CAPTURE transaction found on the order",
          }),
        ) as Effect.Effect<never, ShopifyError>,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyRefundCreate.execute(
          {
            orderId: "gid://shopify/Order/12345",
            amount: { amount: "50.00", currencyCode: "USD" },
          } as never,
          baseCtx("c-refund-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("refund.create");
        expect(err.issues).toEqual(["RefundFailed"]);
      }
    }
  });

  it("idempotencyKey hashes orderId + amount + currency", () => {
    expect(
      shopifyRefundCreate.idempotencyKey!({
        orderId: "gid://shopify/Order/12345",
        amount: { amount: "29.99", currencyCode: "USD" },
      } as never),
    ).toBe("refund:gid://shopify/Order/12345:29.99:USD");
    // Different amount → different key.
    expect(
      shopifyRefundCreate.idempotencyKey!({
        orderId: "gid://shopify/Order/12345",
        amount: { amount: "30.00", currencyCode: "USD" },
      } as never),
    ).not.toBe(
      shopifyRefundCreate.idempotencyKey!({
        orderId: "gid://shopify/Order/12345",
        amount: { amount: "29.99", currencyCode: "USD" },
      } as never),
    );
  });

  it("declares the right risk + sideEffectClass + defaultPermission", () => {
    expect(shopifyRefundCreate.risk).toBe("money");
    expect(shopifyRefundCreate.sideEffectClass).toBe("financial");
    expect(shopifyRefundCreate.defaultPermission).toBe("ask");
  });
});
