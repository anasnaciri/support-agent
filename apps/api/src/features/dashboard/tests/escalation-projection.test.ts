import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomerId,
  OrderId,
  TenantId,
  type ShopifyFulfillment,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import {
  resolveCanonicalOrder,
  fulfillmentOperatorOrderProjection,
} from "../escalation-projection.js";

const buildFulfillment = (
  trackingNumbers: ReadonlyArray<string>,
  createdAt: string,
): ShopifyFulfillment => ({
  id: `gid://shopify/Fulfillment/${createdAt}`,
  status: "in_transit",
  trackingCompany: null,
  trackingNumbers,
  trackingUrls: [],
  estimatedDeliveryAt: null,
  deliveredAt: null,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

const buildOrder = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: OrderId("gid://shopify/Order/12345"),
  name: "#1001",
  confirmationNumber: null,
  email: "customer@example.com",
  customerId: CustomerId("gid://shopify/Customer/777"),
  fulfillmentStatus: "in_transit",
  financialStatus: "paid",
  cancelledAt: null,
  totalPrice: { amount: "29.99", currencyCode: "USD" },
  shippingAddress: {
    name: "Jane Doe",
    address1: "1 Main St",
    address2: null,
    city: "Lisbon",
    province: null,
    country: "Portugal",
    zip: "1000-001",
    phone: null,
  },
  lineItems: [],
  fulfillments: [],
  createdAt: new Date("2026-05-14T00:00:00.000Z"),
  updatedAt: new Date("2026-05-15T00:00:00.000Z"),
  ...over,
});

describe("fulfillmentOperatorOrderProjection", () => {
  it("is all-null without an order", () => {
    expect(fulfillmentOperatorOrderProjection(null)).toEqual({
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
  });

  it("projects order ref, ship city/country, and the newest tracking number", () => {
    const order = buildOrder({
      fulfillments: [
        buildFulfillment(["OLD-1"], "2026-05-14T00:00:00.000Z"),
        buildFulfillment([], "2026-05-15T00:00:00.000Z"),
        buildFulfillment(["NEW-1", "NEW-2"], "2026-05-16T00:00:00.000Z"),
      ],
    });
    expect(fulfillmentOperatorOrderProjection(order)).toEqual({
      orderRef: "#1001",
      shipCity: "Lisbon",
      shipCountry: "Portugal",
      // The newest fulfillment that actually carries a number, first number.
      trackingNumber: "NEW-1",
    });
  });

  it("nulls the address/tracking slots it can't fill", () => {
    const order = buildOrder({ shippingAddress: null, fulfillments: [] });
    expect(fulfillmentOperatorOrderProjection(order)).toEqual({
      orderRef: "#1001",
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
  });
});

describe("resolveCanonicalOrder", () => {
  const gid = "gid://shopify/Order/12345";

  it("resolves a canonical GID exactly via getOrder", async () => {
    const env = ShopifyServiceTest({
      orders: new Map([[OrderId(gid), buildOrder()]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCanonicalOrder(TenantId("t1"), { identifiedOrderId: gid }),
        env,
      ),
    );
    expect(result?.id).toBe(gid);
  });

  it("never falls back to the customer's quoted ref (fulfillment-partner-facing data)", async () => {
    // A quoted ref is an UNTRUSTED customer hint — resolving it fuzzily could
    // point the fulfillment partner at someone else's order. Canonical GID or nothing.
    const env = ShopifyServiceTest({
      ordersByName: new Map([["#1001", buildOrder()]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCanonicalOrder(TenantId("t1"), { quotedOrderRef: "#1001" }),
        env,
      ),
    );
    expect(result).toBeNull();
  });

  it("ignores a legacy non-GID identifiedOrderId", async () => {
    const env = ShopifyServiceTest({
      ordersByName: new Map([["#1001", buildOrder()]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCanonicalOrder(TenantId("t1"), { identifiedOrderId: "#1001" }),
        env,
      ),
    );
    expect(result).toBeNull();
  });

  it("resolves to null when the lookup fails (no creds / order gone)", async () => {
    const env = ShopifyServiceTest({}); // empty map → OrderNotFound
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCanonicalOrder(TenantId("t1"), { identifiedOrderId: gid }),
        env,
      ),
    );
    expect(result).toBeNull();
  });
});
