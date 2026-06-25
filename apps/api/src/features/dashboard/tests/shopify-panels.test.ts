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
  it("resolves the canonical GID identifiedOrderId exactly via getOrder, ignoring a stale quoted ref", async () => {
    // The single source of truth: once the runtime has stamped a GID, the panel
    // resolves THAT order exactly — never a fuzzy re-search that could diverge.
    const order = buildOrder("gid://shopify/Order/12345");
    const env = ShopifyServiceTest({
      orders: new Map([[OrderId("gid://shopify/Order/12345"), order]]),
      // A leftover quoted ref pointing at a DIFFERENT order must be ignored.
      ordersByConfirmationNumber: new Map([
        ["WRONG", buildOrder("gid://shopify/Order/99999")],
      ]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveOrderForContext(TenantId("t1"), {
          identifiedOrderId: "gid://shopify/Order/12345",
          quotedOrderRef: "WRONG",
        }),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Order/12345");
  });

  it("falls back to the customer's quotedOrderRef before the order has resolved", async () => {
    // In-flight case: no canonical GID yet, but triage recorded what the
    // customer quoted — show that so the panel isn't blank pre-resolution.
    const order = buildOrder("gid://shopify/Order/12345");
    const env = ShopifyServiceTest({
      ordersByName: new Map([["#1001", order]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveOrderForContext(TenantId("t1"), { quotedOrderRef: "#1001" }),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Order/12345");
  });

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
