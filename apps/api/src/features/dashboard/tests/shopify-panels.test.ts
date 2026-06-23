import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomerId,
  OrderId,
  TenantId,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import {
  isNonEmptyString,
  looksLikeGid,
  looksLikeOrderName,
  resolveOrderForContext,
} from "../shopify-panels.js";

const buildOrder = (id: string): ShopifyOrder => ({
  id: OrderId(id),
  name: "#1001",
  confirmationNumber: "XPAV284CT",
  email: "customer@example.com",
  customerId: CustomerId("gid://shopify/Customer/777"),
  fulfillmentStatus: "in_transit",
  financialStatus: "paid",
  totalPrice: { amount: "29.99", currencyCode: "USD" },
  shippingAddress: null,
  lineItems: [],
  fulfillments: [],
  createdAt: new Date("2026-05-14T00:00:00.000Z"),
  updatedAt: new Date("2026-05-15T00:00:00.000Z"),
});

describe("resolveOrderForContext", () => {
  it("resolves a confirmation-number identifiedOrderId via the confirmation fallback", async () => {
    const order = buildOrder("gid://shopify/Order/12345");
    const env = ShopifyServiceTest({
      // No ordersByName entry — only reachable via confirmation lookup.
      ordersByConfirmationNumber: new Map([["XPAV284CT", order]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveOrderForContext(TenantId("t1"), {
          identifiedOrderId: "XPAV284CT",
        }),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Order/12345");
    expect(result?.confirmationNumber).toBe("XPAV284CT");
  });
});

describe("dashboard-shopify id heuristics", () => {
  it("isNonEmptyString", () => {
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });

  it("looksLikeOrderName matches #1001 / 1001, not gids", () => {
    expect(looksLikeOrderName("#1001")).toBe(true);
    expect(looksLikeOrderName("1001")).toBe(true);
    expect(looksLikeOrderName("gid://shopify/Order/9")).toBe(false);
    expect(looksLikeOrderName("abc")).toBe(false);
  });

  it("looksLikeGid matches Order/Customer gids only", () => {
    expect(looksLikeGid("gid://shopify/Order/9")).toBe(true);
    expect(looksLikeGid("gid://shopify/Customer/9")).toBe(true);
    expect(looksLikeGid("#1001")).toBe(false);
    expect(looksLikeGid("gid://shopify/Product/9")).toBe(false);
  });
});
