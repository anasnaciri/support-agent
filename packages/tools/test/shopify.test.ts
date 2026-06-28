import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  CustomerId,
  OrderId,
  OrderCancelFailed,
  RefundFailed,
  ShopifyAuthMissing,
  TenantId,
  ToolOutputInvalid,
  type ShopifyCustomer,
  type ShopifyError,
  type ShopifyOrder,
  type ShopifyOrderCancellation,
  type ShopifyProduct,
  type ShopifyProductSearchResult,
  type ToolContext,
} from "@support-agent/agent-core";
import { ShopifyServiceTest } from "@support-agent/services";
import {
  shopifyGetCustomer,
  shopifyGetOrder,
  shopifyFindCustomerOrder,
  shopifyGetProduct,
  shopifyGetStoreInfo,
  shopifyListPickupLocations,
  shopifySearchProducts,
  shopifyRefundCreate,
  shopifyRefundRecommend,
  shopifyOrderCancel,
  computeRefundRecommendation,
} from "../src/index.js";
import {
  TenantRepositoryTest,
  TenantSettings,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  type CancelOrderInput,
  type CustomerRefundHistory,
  type RefundPolicy,
} from "@support-agent/services";

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
  confirmationNumber: "XPAV284CT",
  email: "customer@example.com",
  customerId: CustomerId("gid://shopify/Customer/777"),
  fulfillmentStatus: "in_transit",
  financialStatus: "paid",
  cancelledAt: null,
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
      productId: "gid://shopify/Product/555",
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

  // Customers who can't find the `#1001` order name often quote the
  // alphanumeric confirmation number from their email instead. When the
  // name search misses, the tool falls back to a confirmation-number
  // lookup before giving up.
  it("falls back to confirmation-number lookup when the name search misses", async () => {
    const order = buildOrder("gid://shopify/Order/12098337702252");
    const env = ShopifyServiceTest({
      // No ordersByName entry → name search misses → fallback fires.
      ordersByConfirmationNumber: new Map([["XPAV284CT", order]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId: "XPAV284CT" } as never,
          baseCtx("c-conf"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["name"]).toBe("#1001");
    expect(result["confirmationNumber"]).toBe("XPAV284CT");
  });

  it("surfaces the order's confirmationNumber in the output payload", async () => {
    const orderId = OrderId("gid://shopify/Order/12345");
    const env = ShopifyServiceTest({
      orders: new Map([[orderId, buildOrder(orderId)]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetOrder.execute(
          { orderId } as never,
          baseCtx("c-surface"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect((exit.value as Record<string, unknown>)["confirmationNumber"]).toBe(
      "XPAV284CT",
    );
  });

  it("maps a miss on BOTH name and confirmation lookups to ToolOutputInvalid OrderNotFound", async () => {
    // Both ordersByName and ordersByConfirmationNumber are empty → both
    // searches return null → the tool MUST map that to ToolOutputInvalid,
    // not silently succeed with null and crash the output-schema decode at
    // the runtime boundary.
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

describe("shopify.get_product tool", () => {
  const buildProduct = (id: string): ShopifyProduct => ({
    id,
    title: "Ceramic Mug",
    productType: "Drinkware",
    vendor: "Acme",
    images: [
      { url: "https://cdn.shopify.com/mug-front.jpg", altText: "Front" },
      { url: "https://cdn.shopify.com/mug-side.jpg", altText: null },
    ],
  });

  it("returns a flattened product payload on success", async () => {
    const productId = "gid://shopify/Product/555";
    const env = ShopifyServiceTest({
      productsById: new Map([[productId, buildProduct(productId)]]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetProduct.execute(
          { productId } as never,
          baseCtx("c-prod-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["id"]).toBe(productId);
    expect(result["title"]).toBe("Ceramic Mug");
    expect(result["productType"]).toBe("Drinkware");
    expect(result["vendor"]).toBe("Acme");
    const images = result["images"] as ReadonlyArray<Record<string, unknown>>;
    expect(images).toHaveLength(2);
    expect(images[0]!["url"]).toBe("https://cdn.shopify.com/mug-front.jpg");
    expect(images[1]!["altText"]).toBeNull();
  });

  it("maps ProductNotFound to ToolOutputInvalid", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetProduct.execute(
          { productId: "gid://shopify/Product/999" } as never,
          baseCtx("c-prod-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.get_product");
        expect(err.issues).toEqual(["ProductNotFound"]);
      }
    }
  });

  it("declares read risk, allow permission, and read_products scope", () => {
    expect(shopifyGetProduct.risk).toBe("read");
    expect(shopifyGetProduct.defaultPermission).toBe("allow");
    expect(shopifyGetProduct.sideEffectClass).toBe("none");
    expect(shopifyGetProduct.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: ["read_products"],
    });
  });
});

describe("shopify.search_products tool", () => {
  const hit = (
    id: string,
    title: string,
    description: string | null,
  ): ShopifyProductSearchResult => ({
    id,
    title,
    productType: "Drinkware",
    vendor: "Acme",
    description,
    priceMin: { amount: "12.99", currencyCode: "EUR" },
    priceMax: { amount: "15.99", currencyCode: "EUR" },
    availableForSale: true,
    onlineStoreUrl: "https://shop.example.com/products/ceramic-mug",
    options: [{ name: "Size", values: ["Small", "Large"] }],
    variants: [
      {
        title: "Small",
        price: { amount: "12.99", currencyCode: "EUR" },
        availableForSale: true,
      },
      {
        title: "Large",
        price: { amount: "15.99", currencyCode: "EUR" },
        availableForSale: false,
      },
    ],
  });

  it("returns matching products with pre-sale grounding fields on success", async () => {
    const env = ShopifyServiceTest({
      searchProducts: (q) =>
        q.includes("mug")
          ? [hit("gid://shopify/Product/1", "Ceramic Mug", "Holds 12oz")]
          : [],
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifySearchProducts.execute(
          { query: "mug" } as never,
          baseCtx("c-sp-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const products = (exit.value as Record<string, unknown>)[
      "products"
    ] as ReadonlyArray<Record<string, unknown>>;
    expect(products).toHaveLength(1);
    expect(products[0]!["title"]).toBe("Ceramic Mug");
    expect(products[0]!["description"]).toBe("Holds 12oz");
    expect(products[0]!["vendor"]).toBe("Acme");
    // The enriched pre-sale fields pass through to the agent: price range
    // (with the store's real currency), availability, URL, options, variants.
    expect(products[0]!["priceMin"]).toEqual({
      amount: "12.99",
      currencyCode: "EUR",
    });
    expect(products[0]!["priceMax"]).toEqual({
      amount: "15.99",
      currencyCode: "EUR",
    });
    expect(products[0]!["availableForSale"]).toBe(true);
    expect(products[0]!["onlineStoreUrl"]).toBe(
      "https://shop.example.com/products/ceramic-mug",
    );
    expect(products[0]!["options"]).toEqual([
      { name: "Size", values: ["Small", "Large"] },
    ]);
    expect(products[0]!["variants"]).toHaveLength(2);
  });

  it("returns an empty list when nothing matches (a miss is not an error)", async () => {
    const env = ShopifyServiceTest({ searchProducts: () => [] });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifySearchProducts.execute(
          { query: "spaceship" } as never,
          baseCtx("c-sp-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect((exit.value as Record<string, unknown>)["products"]).toEqual([]);
  });

  it("maps a ShopifyError to ToolOutputInvalid", async () => {
    const env = Layer.succeed(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@support-agent/services")).ShopifyService as any,
      {
        searchProducts: () =>
          Effect.fail(new ShopifyAuthMissing({ tenantId })),
      },
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifySearchProducts.execute(
          { query: "mug" } as never,
          baseCtx("c-sp-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.search_products");
        expect(err.issues).toEqual(["ShopifyAuthMissing"]);
      }
    }
  });

  it("declares read risk, allow permission, read_products scope, and no tenant-control surface", () => {
    expect(shopifySearchProducts.name).toBe("shopify.search_products");
    expect(shopifySearchProducts.risk).toBe("read");
    expect(shopifySearchProducts.defaultPermission).toBe("allow");
    expect(shopifySearchProducts.sideEffectClass).toBe("none");
    expect(shopifySearchProducts.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: ["read_products"],
    });
    // Internal plumbing, not a tenant-configurable action — must stay out
    // of the per-agent Actions UI (mirrors knowledge.search).
    expect(
      (shopifySearchProducts as { tenantControl?: unknown }).tenantControl,
    ).toBeUndefined();
    expect(
      (shopifySearchProducts as { displayName?: unknown }).displayName,
    ).toBeUndefined();
  });
});

describe("shopify.get_store_info tool", () => {
  const info = (countries: ReadonlyArray<string>) => ({
    name: "Test Shop",
    contactEmail: "hello@test-shop.example.com",
    currencyCode: "EUR",
    primaryDomainUrl: "https://test-shop.example.com",
    shipsToCountries: countries,
  });

  it("returns public store facts with the explicit country list when small", async () => {
    const env = ShopifyServiceTest({ shopInfo: info(["DE", "FR", "GB"]) });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetStoreInfo.execute(
          {} as never,
          baseCtx("c-si-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const out = exit.value as Record<string, unknown>;
    expect(out["name"]).toBe("Test Shop");
    expect(out["contactEmail"]).toBe("hello@test-shop.example.com");
    expect(out["currencyCode"]).toBe("EUR");
    expect(out["domain"]).toBe("https://test-shop.example.com");
    expect(out["shipsWorldwide"]).toBe(false);
    expect(out["shipsToCountries"]).toEqual(["DE", "FR", "GB"]);
  });

  it("compresses a rest-of-world zone to shipsWorldwide instead of ~240 codes", async () => {
    const many = Array.from({ length: 240 }, (_, i) => `C${i}`);
    const env = ShopifyServiceTest({ shopInfo: info(many) });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetStoreInfo.execute(
          {} as never,
          baseCtx("c-si-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const out = exit.value as Record<string, unknown>;
    expect(out["shipsWorldwide"]).toBe(true);
    // The list is dropped, not truncated — a partial list would read as
    // "only these countries" and make the agent give wrong ship-to answers.
    expect(out["shipsToCountries"]).toBeNull();
  });

  it("maps a ShopifyError to ToolOutputInvalid (no Shopify connection)", async () => {
    // No shopInfo fixture → the Test layer fails with ShopifyAuthMissing.
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyGetStoreInfo.execute(
          {} as never,
          baseCtx("c-si-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.get_store_info");
        expect(err.issues).toEqual(["ShopifyAuthMissing"]);
      }
    }
  });

  it("declares read risk, allow permission, an active-connection requirement, and no tenant-control surface", () => {
    expect(shopifyGetStoreInfo.name).toBe("shopify.get_store_info");
    expect(shopifyGetStoreInfo.risk).toBe("read");
    expect(shopifyGetStoreInfo.defaultPermission).toBe("allow");
    expect(shopifyGetStoreInfo.sideEffectClass).toBe("none");
    // Basic shop fields need no extra OAuth scope, but the empty scopes
    // array still makes PermissionService require an ACTIVE Shopify
    // connection before the tool can run.
    expect(shopifyGetStoreInfo.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: [],
    });
    expect(
      (shopifyGetStoreInfo as { tenantControl?: unknown }).tenantControl,
    ).toBeUndefined();
    expect(
      (shopifyGetStoreInfo as { displayName?: unknown }).displayName,
    ).toBeUndefined();
  });
});

describe("shopify.list_pickup_locations tool", () => {
  const downtown = {
    name: "Downtown store",
    instructions: "Ring the bell.",
    address1: "1 Main St",
    address2: null,
    city: "Berlin",
    province: null,
    country: "Germany",
    zip: "10115",
    phone: "+49 30 1234",
  };

  it("returns the store's pickup locations", async () => {
    const env = ShopifyServiceTest({ pickupLocations: [downtown] });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyListPickupLocations.execute(
          {} as never,
          baseCtx("c-pl-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const out = exit.value as Record<string, unknown>;
    expect(out["locations"]).toEqual([downtown]);
  });

  it("returns an empty list when the store offers no pickup", async () => {
    const env = ShopifyServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyListPickupLocations.execute(
          {} as never,
          baseCtx("c-pl-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect((exit.value as Record<string, unknown>)["locations"]).toEqual([]);
  });

  it("maps a ShopifyError to ToolOutputInvalid", async () => {
    const env = Layer.succeed(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@support-agent/services")).ShopifyService as any,
      {
        listPickupLocations: () =>
          Effect.fail(new ShopifyAuthMissing({ tenantId })),
      },
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyListPickupLocations.execute(
          {} as never,
          baseCtx("c-pl-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("shopify.list_pickup_locations");
        expect(err.issues).toEqual(["ShopifyAuthMissing"]);
      }
    }
  });

  it("declares read risk, allow permission, read_locations scope, and no tenant-control surface", () => {
    expect(shopifyListPickupLocations.name).toBe(
      "shopify.list_pickup_locations",
    );
    expect(shopifyListPickupLocations.risk).toBe("read");
    expect(shopifyListPickupLocations.defaultPermission).toBe("allow");
    expect(shopifyListPickupLocations.sideEffectClass).toBe("none");
    expect(shopifyListPickupLocations.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: ["read_locations"],
    });
    expect(
      (shopifyListPickupLocations as { tenantControl?: unknown })
        .tenantControl,
    ).toBeUndefined();
    expect(
      (shopifyListPickupLocations as { displayName?: unknown }).displayName,
    ).toBeUndefined();
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

describe("order.cancel tool", () => {
  // Layer with a settings row for the tool's restock read + a cancelOrder
  // capture so we can assert the forced flags (refund:true, notifyCustomer:
  // false) and the restock value taken from the tenant setting.
  const envWith = (
    cancellationRestock: boolean,
    capture: { input?: CancelOrderInput },
  ) => {
    const shopify = ShopifyServiceTest({
      cancelOrder: (input) => {
        capture.input = input;
        return Effect.succeed<ShopifyOrderCancellation>({
          orderId: input.orderId,
          jobId: "gid://shopify/Job/xyz",
          accepted: true,
        });
      },
    });
    const tenants = TenantRepositoryTest({
      settingsByTenant: new Map([
        [
          tenantId,
          new TenantSettings({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            retentionDays: 730,
            supplierEscalationSheet: null,
            legalAcceptance: null,
            cancellationRestock,
          }),
        ],
      ]),
    });
    return Layer.merge(shopify, tenants);
  };

  it("cancels with refund forced on, notifyCustomer off, and restock from settings", async () => {
    const capture: { input?: CancelOrderInput } = {};
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyOrderCancel.execute(
          {
            orderId: "gid://shopify/Order/55",
            amount: { amount: "29.99", currencyCode: "USD" },
            reason: "Customer changed their mind",
          } as never,
          baseCtx("c-cancel-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        envWith(true, capture),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["orderId"]).toBe("gid://shopify/Order/55");
    expect(result["jobId"]).toBe("gid://shopify/Job/xyz");
    expect(result["accepted"]).toBe(true);
    // The tool forces these — the agent never chooses them.
    expect(capture.input?.reason).toBe("customer");
    expect(capture.input?.refund).toBe(true);
    expect(capture.input?.notifyCustomer).toBe(false);
    expect(capture.input?.restock).toBe(true);
    expect(capture.input?.staffNote).toBe("Customer changed their mind");
  });

  it("passes restock=false when the tenant disabled restock-on-cancel", async () => {
    const capture: { input?: CancelOrderInput } = {};
    await Effect.runPromiseExit(
      Effect.provide(
        shopifyOrderCancel.execute(
          {
            orderId: "gid://shopify/Order/55",
            amount: { amount: "29.99", currencyCode: "USD" },
          } as never,
          baseCtx("c-cancel-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        envWith(false, capture),
      ),
    );
    expect(capture.input?.restock).toBe(false);
  });

  it("maps OrderCancelFailed to ToolOutputInvalid with the tag in issues", async () => {
    const shopify = ShopifyServiceTest({
      cancelOrder: () =>
        Effect.fail(
          new OrderCancelFailed({
            orderId: "gid://shopify/Order/55",
            code: "CANT_CANCEL",
            message: "Order has already been fulfilled",
          }),
        ) as Effect.Effect<never, ShopifyError>,
    });
    const tenants = TenantRepositoryTest({
      settingsByTenant: new Map([
        [
          tenantId,
          new TenantSettings({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            retentionDays: 730,
            supplierEscalationSheet: null,
            legalAcceptance: null,
            cancellationRestock: true,
          }),
        ],
      ]),
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyOrderCancel.execute(
          {
            orderId: "gid://shopify/Order/55",
            amount: { amount: "29.99", currencyCode: "USD" },
          } as never,
          baseCtx("c-cancel-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        Layer.merge(shopify, tenants),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("order.cancel");
        expect(err.issues).toEqual(["OrderCancelFailed"]);
      }
    }
  });

  it("idempotencyKey is stable per order", () => {
    expect(
      shopifyOrderCancel.idempotencyKey!({
        orderId: "gid://shopify/Order/55",
        amount: { amount: "29.99", currencyCode: "USD" },
      } as never),
    ).toBe("cancel:gid://shopify/Order/55");
  });

  it("declares money risk, write_orders scope, and refund-threshold control", () => {
    expect(shopifyOrderCancel.risk).toBe("money");
    expect(shopifyOrderCancel.defaultPermission).toBe("ask");
    expect(shopifyOrderCancel.tenantControl).toBe("refund-threshold");
    expect(shopifyOrderCancel.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: ["write_orders"],
    });
  });
});

describe("refund.recommend — pure logic", () => {
  const emptyHistory: CustomerRefundHistory = {
    ordersCount: 0,
    refundedOrdersCount: 0,
    totalRefundedAmount: null,
    firstOrderAt: null,
  };
  const policy: RefundPolicy = {
    askAboveMinorUnits: 2_500, // $25
    denyAboveMinorUnits: 50_000, // $500
    currencyCode: "USD",
  };
  const now = new Date("2026-05-26T00:00:00.000Z");

  const mkOrder = (
    overrides: Partial<ShopifyOrder> = {},
  ): ShopifyOrder => ({
    ...buildOrder("gid://shopify/Order/777"),
    ...overrides,
  });

  it("deny when the order is already fully refunded", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({ financialStatus: "refunded" }),
      policy,
      history: emptyHistory,
      now,
    });
    expect(d.recommendation).toBe("deny");
    expect(d.amount).toBeNull();
    expect(d.reasoning).toContain("already fully refunded");
  });

  it("deny when the package was delivered > 30 days ago (return window expired)", () => {
    const longAgo = new Date("2025-12-01T00:00:00.000Z");
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        fulfillmentStatus: "delivered",
        fulfillments: [
          {
            ...buildOrder("x").fulfillments[0]!,
            deliveredAt: longAgo,
          },
        ],
      }),
      policy,
      history: emptyHistory,
      now,
    });
    expect(d.recommendation).toBe("deny");
    expect(d.reasoning).toContain("Return window expired");
  });

  it("full_refund when paid, within window, amount under askAbove", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "19.99", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: emptyHistory,
      now,
    });
    expect(d.recommendation).toBe("full_refund");
    expect(d.amount).toEqual({ amount: "19.99", currencyCode: "USD" });
    expect(d.riskFlags).toEqual([]);
  });

  it("investigate when amount exceeds the hard cap (denyAbove)", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "999.99", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: emptyHistory,
      now,
    });
    expect(d.recommendation).toBe("investigate");
    expect(d.amount).toEqual({ amount: "999.99", currencyCode: "USD" });
    expect(d.reasoning).toContain("hard cap");
  });

  it("investigate when the order currency differs from policy currency (no FX)", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "20.00", currencyCode: "EUR" },
        fulfillments: [],
      }),
      policy, // USD policy
      history: emptyHistory,
      now,
    });
    expect(d.recommendation).toBe("investigate");
    expect(d.amount).toEqual({ amount: "20.00", currencyCode: "EUR" });
    expect(d.reasoning).toContain("differs from policy currency");
  });

  it("flags first_order when customer has ordersCount === 1", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "20.00", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: {
        ordersCount: 1,
        refundedOrdersCount: 0,
        totalRefundedAmount: null,
        firstOrderAt: now,
      },
      now,
    });
    expect(d.recommendation).toBe("full_refund");
    expect(d.riskFlags).toContain("first_order");
    expect(d.riskFlags).toContain("new_customer");
  });

  it("flags frequent_refunder when > 30% of past orders had refunds", () => {
    const d = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "20.00", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: {
        ordersCount: 5,
        refundedOrdersCount: 3, // 60%
        totalRefundedAmount: { amount: "150.00", currencyCode: "USD" },
        firstOrderAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      now,
    });
    expect(d.recommendation).toBe("full_refund");
    expect(d.riskFlags).toContain("frequent_refunder");
    expect(d.riskFlags).not.toContain("new_customer");
  });

  it("flags high_ltv only when refund-history currency matches the policy currency", () => {
    // Match → flag fires.
    const matched = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "20.00", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: {
        ordersCount: 10,
        refundedOrdersCount: 2,
        totalRefundedAmount: { amount: "1200.00", currencyCode: "USD" },
        firstOrderAt: new Date("2023-01-01T00:00:00.000Z"),
      },
      now,
    });
    expect(matched.riskFlags).toContain("high_ltv");

    // Mismatch → flag does NOT fire (we don't invent an FX rate).
    const mismatched = computeRefundRecommendation({
      order: mkOrder({
        financialStatus: "paid",
        totalPrice: { amount: "20.00", currencyCode: "USD" },
        fulfillments: [],
      }),
      policy,
      history: {
        ordersCount: 10,
        refundedOrdersCount: 2,
        totalRefundedAmount: { amount: "1200.00", currencyCode: "EUR" },
        firstOrderAt: new Date("2023-01-01T00:00:00.000Z"),
      },
      now,
    });
    expect(mismatched.riskFlags).not.toContain("high_ltv");
  });
});

describe("refund.recommend — tool wire-up", () => {
  const refundTenantId = TenantId("tenant-rec-1");
  const refundCtx: ToolContext = {
    tenantId: refundTenantId,
    caseId: CaseId("c-rec-1"),
    agentId: AgentId("refund-review-agent"),
    callId: "call_1",
    attemptNumber: 1,
  };
  const orderGid = OrderId("gid://shopify/Order/999");
  const fixtureOrder = (overrides: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
    ...buildOrder("gid://shopify/Order/999"),
    id: orderGid,
    financialStatus: "paid",
    totalPrice: { amount: "19.99", currencyCode: "USD" },
    fulfillments: [],
    ...overrides,
  });

  const buildEnv = (order: ShopifyOrder, history?: CustomerRefundHistory) => {
    const shopify = ShopifyServiceTest({
      orders: new Map([[order.id, order]]),
      ...(history && order.customerId
        ? { customerRefundHistory: new Map([[order.customerId, history]]) }
        : {}),
    });
    const tenants = TenantRepositoryTest({
      settingsByTenant: new Map([
        [
          refundTenantId,
          new TenantSettings({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            retentionDays: 730,
            supplierEscalationSheet: null,
            legalAcceptance: null,
          }),
        ],
      ]),
    });
    return Layer.mergeAll(shopify, tenants);
  };

  it("happy path returns the discriminated recommendation + amount + risk flags", async () => {
    const env = buildEnv(
      fixtureOrder({
        financialStatus: "paid",
        totalPrice: { amount: "19.99", currencyCode: "USD" },
      }),
      {
        ordersCount: 1,
        refundedOrdersCount: 0,
        totalRefundedAmount: null,
        firstOrderAt: new Date(),
      },
    );

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyRefundRecommend.execute(
          { orderId: orderGid } as never,
          refundCtx,
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(["full_refund", "investigate"]).toContain(result["recommendation"]);
    expect(result["amount"]).toEqual({ amount: "19.99", currencyCode: "USD" });
    expect(Array.isArray(result["riskFlags"])).toBe(true);
  });

  it("falls back to zero history when customer lookup fails", async () => {
    // Order has a customerId, but the Test layer has no history fixture
    // for that id → default impl returns the zero history → tool still
    // succeeds.
    const env = buildEnv(fixtureOrder());
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        shopifyRefundRecommend.execute(
          { orderId: orderGid } as never,
          refundCtx,
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("declares the read-only surface (no scopes / risk read / allow)", () => {
    expect(shopifyRefundRecommend.name).toBe("refund.recommend");
    expect(shopifyRefundRecommend.risk).toBe("read");
    expect(shopifyRefundRecommend.defaultPermission).toBe("allow");
    expect(shopifyRefundRecommend.sideEffectClass).toBe("none");
    expect(shopifyRefundRecommend.requiredConnectorScopes).toBeUndefined();
  });
});

describe("shopify.find_customer_order tool", () => {
  const run = (email: string, env: ReturnType<typeof ShopifyServiceTest>) =>
    Effect.runPromiseExit(
      Effect.provide(
        shopifyFindCustomerOrder.execute(
          { email } as never,
          baseCtx("c-fco"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );

  it("infers the single order when the customer has exactly one", async () => {
    const orderId = OrderId("gid://shopify/Order/900");
    const env = ShopifyServiceTest({
      ordersByEmail: new Map([
        ["solo@example.com", [buildOrder(orderId)]],
      ]),
    });

    const exit = await run("solo@example.com", env);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["status"]).toBe("single");
    expect(result["orderCount"]).toBe(1);
    expect((result["order"] as Record<string, unknown>)["id"]).toBe(orderId);
    expect((result["order"] as Record<string, unknown>)["name"]).toBe("#1001");
  });

  it("returns `none` when no orders match the email", async () => {
    const env = ShopifyServiceTest({ ordersByEmail: new Map() });
    const exit = await run("nobody@example.com", env);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["status"]).toBe("none");
    expect(result["orderCount"]).toBe(0);
    expect(result["order"]).toBeNull();
  });

  it("returns `multiple` (and no order) when the customer has more than one", async () => {
    const env = ShopifyServiceTest({
      ordersByEmail: new Map([
        [
          "repeat@example.com",
          [
            buildOrder(OrderId("gid://shopify/Order/1")),
            buildOrder(OrderId("gid://shopify/Order/2")),
          ],
        ],
      ]),
    });

    const exit = await run("repeat@example.com", env);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(result["status"]).toBe("multiple");
    expect(result["orderCount"]).toBe(2);
    expect(result["order"]).toBeNull();
  });

  it("fails with ToolOutputInvalid when the email is blank", async () => {
    const env = ShopifyServiceTest({});
    const exit = await run("   ", env);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("declares the read-only surface (read_orders / risk read / allow)", () => {
    expect(shopifyFindCustomerOrder.name).toBe("shopify.find_customer_order");
    expect(shopifyFindCustomerOrder.risk).toBe("read");
    expect(shopifyFindCustomerOrder.defaultPermission).toBe("allow");
    expect(shopifyFindCustomerOrder.sideEffectClass).toBe("none");
    expect(shopifyFindCustomerOrder.requiredConnectorScopes).toEqual({
      provider: "shopify",
      scopes: ["read_orders"],
    });
  });
});
