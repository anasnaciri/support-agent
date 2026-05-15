import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  CustomerId,
  OrderId,
  ShopifyAuthMissing,
  TenantId,
  ToolOutputInvalid,
  type ShopifyOrder,
  type ToolContext,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import { shopifyGetOrder } from "../src/index.js";

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
  it("returns a flattened order payload on success", async () => {
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

  it("propagates ShopifyAuthMissing through the tool boundary", async () => {
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
