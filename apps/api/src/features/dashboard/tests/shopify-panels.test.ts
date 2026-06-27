import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomerId,
  OrderId,
  TenantId,
  type ShopifyCustomer,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import {
  isNonEmptyString,
  looksLikeGid,
  looksLikeOrderName,
  resolveCustomerForContext,
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

const buildCustomer = (id: string, email: string): ShopifyCustomer => ({
  id: CustomerId(id),
  email,
  firstName: "Sue",
  lastName: "Smith",
  phone: null,
  ordersCount: 3,
  totalSpent: { amount: "120.00", currencyCode: "USD" },
  defaultAddress: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("resolveCustomerForContext (single source of truth, with fallbacks)", () => {
  it("resolves the canonical shopifyCustomerId exactly via getCustomer", async () => {
    // The runtime-verified id wins over everything else.
    const cust = buildCustomer("gid://shopify/Customer/777", "sue@example.com");
    const env = ShopifyServiceTest({
      customers: new Map([[CustomerId("gid://shopify/Customer/777"), cust]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCustomerForContext(
          TenantId("t1"),
          { shopifyCustomerId: "gid://shopify/Customer/777" },
          null,
        ),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Customer/777");
  });

  it("falls back to the bound order's customer when the sender email doesn't match (typo case)", async () => {
    // The customer typo'd their email at checkout: searchByEmail on the sender
    // address finds nothing and the runtime never stamped shopifyCustomerId —
    // but the resolved order still carries the customer. This is the fix for
    // the "No matching Shopify customer" panel on a typo'd-email case.
    const cust = buildCustomer(
      "gid://shopify/Customer/777",
      "sue.typo@example.com",
    );
    const order = buildOrder("gid://shopify/Order/12345"); // customerId -> 777
    const env = ShopifyServiceTest({
      customers: new Map([[CustomerId("gid://shopify/Customer/777"), cust]]),
      // The sender address is deliberately absent from customersByEmail.
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCustomerForContext(
          TenantId("t1"),
          { customerEmail: "sue@example.com" },
          order,
        ),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Customer/777");
  });

  it("falls back to searchByEmail on the sender address when there is no id or bound order", async () => {
    const cust = buildCustomer(
      "gid://shopify/Customer/888",
      "match@example.com",
    );
    const env = ShopifyServiceTest({
      customersByEmail: new Map([["match@example.com", cust]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCustomerForContext(
          TenantId("t1"),
          { customerEmail: "match@example.com" },
          null,
        ),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Customer/888");
  });

  it("falls back to the agent-provided identifiedCustomerId hint as a last resort", async () => {
    const cust = buildCustomer("gid://shopify/Customer/999", "hint@example.com");
    const env = ShopifyServiceTest({
      customers: new Map([[CustomerId("gid://shopify/Customer/999"), cust]]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        resolveCustomerForContext(
          TenantId("t1"),
          { identifiedCustomerId: "gid://shopify/Customer/999" },
          null,
        ),
        env,
      ),
    );
    expect(result?.id).toBe("gid://shopify/Customer/999");
  });

  it("returns null when nothing resolves", async () => {
    const env = ShopifyServiceTest({});
    const result = await Effect.runPromise(
      Effect.provide(resolveCustomerForContext(TenantId("t1"), {}, null), env),
    );
    expect(result).toBeNull();
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
