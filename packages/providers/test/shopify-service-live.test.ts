import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomerId,
  CustomerNotFound,
  NetworkError,
  OrderId,
  OrderNotFound,
  ProductNotFound,
  RefundFailed,
  ShopifyAuthFailed,
  ShopifyRateLimited,
  TenantId,
} from "@support-agent/agent-core";
import {
  ShopifyCredentialStoreAny,
  ShopifyService,
} from "@support-agent/services";
import {
  ShopifyHttpFromFn,
  ShopifyServiceLive,
  type ShopifyHttpClient,
} from "../src/shopify-service-live.js";

// ============================================================
// Test helpers
// ============================================================

const tenantId = TenantId("t1");
const creds = {
  shopDomain: "test-shop.myshopify.com",
  accessToken: "shpat_test",
  apiVersion: "2025-01",
};

type Capture = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};
const captures: Array<Capture> = [];

const respond = (
  status: number,
  bodyJson: unknown,
): ReturnType<ShopifyHttpClient> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyJson,
    text: async () =>
      typeof bodyJson === "string" ? bodyJson : JSON.stringify(bodyJson),
  });

const httpFromSequence = (
  responses: ReadonlyArray<() => ReturnType<ShopifyHttpClient>>,
): ShopifyHttpClient => {
  let i = 0;
  return (url, init) => {
    captures.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    const fn = responses[i++];
    if (!fn) throw new Error(`unexpected http call #${i}`);
    return fn();
  };
};

const buildLayer = (http: ShopifyHttpClient) =>
  ShopifyServiceLive.pipe(
    Layer.provide(
      Layer.merge(ShopifyHttpFromFn(http), ShopifyCredentialStoreAny(creds)),
    ),
  );

const reset = () => {
  captures.length = 0;
};

// ============================================================
// Fixtures
// ============================================================

const ORDER_PAYLOAD = {
  data: {
    order: {
      id: "gid://shopify/Order/12345",
      name: "#1001",
      email: "customer@example.com",
      customer: { id: "gid://shopify/Customer/777" },
      displayFulfillmentStatus: "IN_TRANSIT",
      displayFinancialStatus: "PAID",
      totalPriceSet: { shopMoney: { amount: "29.99", currencyCode: "USD" } },
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
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/1",
            title: "Mug",
            quantity: 2,
            sku: "MUG-01",
            variantTitle: null,
            product: { id: "gid://shopify/Product/555" },
          },
        ],
      },
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          displayStatus: "IN_TRANSIT",
          status: null,
          trackingInfo: [
            {
              company: "UPS",
              number: "1Z999",
              url: "https://wwwapps.ups.com/tracking?t=1Z999",
            },
          ],
          estimatedDeliveryAt: "2026-05-20T00:00:00.000Z",
          deliveredAt: null,
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
  },
};

const CUSTOMER_PAYLOAD = {
  data: {
    customer: {
      id: "gid://shopify/Customer/777",
      email: "customer@example.com",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
      numberOfOrders: "3",
      amountSpent: { amount: "89.97", currencyCode: "USD" },
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
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
};

const PRODUCT_PAYLOAD = {
  data: {
    product: {
      id: "gid://shopify/Product/555",
      title: "Ceramic Mug",
      productType: "Drinkware",
      vendor: "Acme",
      images: {
        nodes: [
          {
            url: "https://cdn.shopify.com/mug-front.jpg",
            altText: "Front view",
          },
          { url: "https://cdn.shopify.com/mug-side.jpg", altText: null },
        ],
      },
    },
  },
};

// ============================================================
// Tests
// ============================================================

describe("ShopifyServiceLive — getOrder", () => {
  it("queries the GraphQL Admin endpoint and maps the response", async () => {
    reset();
    const layer = buildLayer(httpFromSequence([() => respond(200, ORDER_PAYLOAD)]));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOrder(tenantId, OrderId("12345")),
        ),
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const order = exit.value;
    expect(order.id).toBe("gid://shopify/Order/12345");
    expect(order.name).toBe("#1001");
    expect(order.fulfillmentStatus).toBe("in_transit");
    expect(order.financialStatus).toBe("paid");
    expect(order.totalPrice).toEqual({ amount: "29.99", currencyCode: "USD" });
    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0]!.title).toBe("Mug");
    expect(order.lineItems[0]!.productId).toBe("gid://shopify/Product/555");
    expect(order.fulfillments[0]!.trackingNumbers).toEqual(["1Z999"]);

    // Verify HTTP request was correctly assembled.
    expect(captures).toHaveLength(1);
    expect(captures[0]!.url).toBe(
      "https://test-shop.myshopify.com/admin/api/2025-01/graphql.json",
    );
    expect(captures[0]!.method).toBe("POST");
    expect(captures[0]!.headers["X-Shopify-Access-Token"]).toBe("shpat_test");
    const body = JSON.parse(captures[0]!.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("query GetOrder");
    expect(body.variables).toEqual({ id: "gid://shopify/Order/12345" });
  });

  it("wraps plain ids with the order gid prefix", async () => {
    reset();
    const layer = buildLayer(httpFromSequence([() => respond(200, ORDER_PAYLOAD)]));
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOrder(tenantId, OrderId("12345")),
        ),
        layer,
      ),
    );
    const body = JSON.parse(captures[0]!.body) as {
      variables: { id: string };
    };
    expect(body.variables.id).toBe("gid://shopify/Order/12345");
  });

  it("fails OrderNotFound when the response order is null", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, { data: { order: null } })]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOrder(tenantId, OrderId("missing")),
        ),
        layer,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(OrderNotFound);
    }
  });
});

describe("ShopifyServiceLive — getShopInfo", () => {
  it("queries public store facts and maps the response", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              shop: {
                name: "Test Shop",
                contactEmail: "hello@test-shop.example.com",
                currencyCode: "EUR",
                primaryDomain: { url: "https://test-shop.example.com" },
                shipsToCountries: ["DE", "FR"],
              },
            },
          }),
      ]),
    );
    const info = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) => s.getShopInfo(tenantId)),
        layer,
      ),
    );
    expect(info).toEqual({
      name: "Test Shop",
      contactEmail: "hello@test-shop.example.com",
      currencyCode: "EUR",
      primaryDomainUrl: "https://test-shop.example.com",
      shipsToCountries: ["DE", "FR"],
    });
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0]!.body) as { query: string };
    expect(body.query).toContain("query ShopInfo");
    // The customer-facing address is `contactEmail`; `shop.email` is the
    // merchant's private account email and must never be selected.
    expect(body.query).toContain("contactEmail");
    expect(/\bemail\b/.test(body.query)).toBe(false);
  });

  it("collapses an empty contactEmail to null", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              shop: {
                name: "Test Shop",
                contactEmail: "",
                currencyCode: "EUR",
                primaryDomain: { url: "https://test-shop.example.com" },
                shipsToCountries: [],
              },
            },
          }),
      ]),
    );
    const info = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) => s.getShopInfo(tenantId)),
        layer,
      ),
    );
    expect(info.contactEmail).toBeNull();
  });
});

describe("ShopifyServiceLive — getShopPolicies", () => {
  it("queries shop policies and maps the response", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              shop: {
                shopPolicies: [
                  {
                    type: "REFUND_POLICY",
                    title: "Refund Policy",
                    body: "<p>Returns within 30 days.</p>",
                    url: "https://test-shop.myshopify.com/policies/refund-policy",
                  },
                  {
                    type: "SHIPPING_POLICY",
                    title: "Shipping Policy",
                    body: "<p>Ships in 3 days.</p>",
                    url: "https://test-shop.myshopify.com/policies/shipping-policy",
                  },
                ],
              },
            },
          }),
      ]),
    );
    const policies = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) => s.getShopPolicies(tenantId)),
        layer,
      ),
    );
    expect(policies).toEqual([
      {
        type: "REFUND_POLICY",
        title: "Refund Policy",
        body: "<p>Returns within 30 days.</p>",
        url: "https://test-shop.myshopify.com/policies/refund-policy",
      },
      {
        type: "SHIPPING_POLICY",
        title: "Shipping Policy",
        body: "<p>Ships in 3 days.</p>",
        url: "https://test-shop.myshopify.com/policies/shipping-policy",
      },
    ]);
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0]!.body) as { query: string };
    expect(body.query).toContain("query ShopPolicies");
  });

  it("returns an empty array when the store has no policies configured", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { shop: { shopPolicies: [] } } }),
      ]),
    );
    const policies = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) => s.getShopPolicies(tenantId)),
        layer,
      ),
    );
    expect(policies).toEqual([]);
  });
});

describe("ShopifyServiceLive — getCustomer + searchByEmail + getFulfillment", () => {
  it("getCustomer maps the GraphQL response", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, CUSTOMER_PAYLOAD)]),
    );
    const customer = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getCustomer(tenantId, CustomerId("777")),
        ),
        layer,
      ),
    );
    expect(customer.id).toBe("gid://shopify/Customer/777");
    expect(customer.email).toBe("customer@example.com");
    expect(customer.ordersCount).toBe(3);
    expect(customer.totalSpent).toEqual({
      amount: "89.97",
      currencyCode: "USD",
    });
  });

  it("getCustomer fails CustomerNotFound when null", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, { data: { customer: null } })]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getCustomer(tenantId, CustomerId("missing")),
        ),
        layer,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(CustomerNotFound);
    }
  });

  it("searchByEmail returns the first match or null", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              customers: { nodes: [CUSTOMER_PAYLOAD.data.customer] },
            },
          }),
        () => respond(200, { data: { customers: { nodes: [] } } }),
      ]),
    );
    const found = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchByEmail(tenantId, "customer@example.com"),
        ),
        layer,
      ),
    );
    expect(found?.email).toBe("customer@example.com");

    const missing = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchByEmail(tenantId, "nobody@example.com"),
        ),
        layer,
      ),
    );
    expect(missing).toBeNull();

    // Verify the query string includes the email filter.
    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string };
    };
    expect(body.variables.q).toBe("email:customer@example.com");
  });

  // Regression test for the 2026-05-16 live demo. Customers reference
  // orders by their *name* (`#1001`), not their internal id
  // (`12098337702252`). The `shopify.get_order` tool dispatches non-GID
  // input through `findOrderByName`, which uses Shopify's `orders` query
  // with `query: "name:#XXXX"`.
  it("findOrderByName issues a name search and maps the first result", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: { orders: { nodes: [ORDER_PAYLOAD.data.order] } },
          }),
      ]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByName(tenantId, "#1001"),
        ),
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).not.toBeNull();
    expect(exit.value!.name).toBe("#1001");
    expect(exit.value!.id).toBe("gid://shopify/Order/12345");

    // Verify the GraphQL `q` variable was built with the leading `#`.
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string };
    };
    expect(body.variables.q).toBe("name:#1001");
  });

  it("findOrderByName auto-prepends `#` when the caller omits it", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: { orders: { nodes: [ORDER_PAYLOAD.data.order] } },
          }),
      ]),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByName(tenantId, "1001"),
        ),
        layer,
      ),
    );
    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string };
    };
    expect(body.variables.q).toBe("name:#1001");
  });

  it("findOrderByName returns null on no match (not a typed error)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { orders: { nodes: [] } } }),
      ]),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByName(tenantId, "#9999"),
        ),
        layer,
      ),
    );
    expect(result).toBeNull();
  });

  it("getFulfillment returns the order's fulfillments array", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              order: { fulfillments: ORDER_PAYLOAD.data.order.fulfillments },
            },
          }),
      ]),
    );
    const fulfillments = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getFulfillment(tenantId, OrderId("12345")),
        ),
        layer,
      ),
    );
    expect(fulfillments).toHaveLength(1);
    expect(fulfillments[0]!.status).toBe("in_transit");
    expect(fulfillments[0]!.trackingNumbers).toEqual(["1Z999"]);
  });
});

describe("ShopifyServiceLive — getProduct", () => {
  it("queries product(id:) and maps title, type, vendor, images", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, PRODUCT_PAYLOAD)]),
    );
    const product = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getProduct(tenantId, "gid://shopify/Product/555"),
        ),
        layer,
      ),
    );
    expect(product.id).toBe("gid://shopify/Product/555");
    expect(product.title).toBe("Ceramic Mug");
    expect(product.productType).toBe("Drinkware");
    expect(product.vendor).toBe("Acme");
    expect(product.images).toHaveLength(2);
    expect(product.images[0]!.url).toBe(
      "https://cdn.shopify.com/mug-front.jpg",
    );
    expect(product.images[0]!.altText).toBe("Front view");
    expect(product.images[1]!.altText).toBeNull();

    const body = JSON.parse(captures[0]!.body) as {
      query: string;
      variables: { id: string };
    };
    expect(body.query).toContain("query GetProduct");
    expect(body.variables.id).toBe("gid://shopify/Product/555");
  });

  it("wraps a bare numeric id with the product gid prefix", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, PRODUCT_PAYLOAD)]),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) => s.getProduct(tenantId, "555")),
        layer,
      ),
    );
    const body = JSON.parse(captures[0]!.body) as { variables: { id: string } };
    expect(body.variables.id).toBe("gid://shopify/Product/555");
  });

  it("fails ProductNotFound when the response product is null", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, { data: { product: null } })]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getProduct(tenantId, "gid://shopify/Product/999"),
        ),
        layer,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(err).toBeInstanceOf(ProductNotFound);
    }
  });
});

describe("ShopifyServiceLive — searchProducts", () => {
  // A full GraphQL node as the enriched SearchProducts query returns it.
  // Overrides let each test vary one aspect without restating the rest.
  const searchNode = (overrides: Record<string, unknown> = {}) => ({
    id: "gid://shopify/Product/1",
    title: "Ceramic Mug",
    productType: "Drinkware",
    vendor: "Acme",
    description: "  Holds 12oz of coffee.  ",
    status: "ACTIVE",
    onlineStoreUrl: "https://test-shop.example.com/products/ceramic-mug",
    priceRangeV2: {
      minVariantPrice: { amount: "12.99", currencyCode: "EUR" },
      maxVariantPrice: { amount: "15.99", currencyCode: "EUR" },
    },
    options: [{ name: "Size", values: ["Small", "Large"] }],
    variants: {
      nodes: [
        { title: "Small", availableForSale: true, price: "12.99" },
        { title: "Large", availableForSale: false, price: "15.99" },
      ],
    },
    ...overrides,
  });

  it("queries products(query:) and maps the enriched search fields", async () => {
    reset();
    const SEARCH_PAYLOAD = {
      data: { products: { nodes: [searchNode()] } },
    };
    const layer = buildLayer(
      httpFromSequence([() => respond(200, SEARCH_PAYLOAD)]),
    );
    const products = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "mug", 5),
        ),
        layer,
      ),
    );
    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.title).toBe("Ceramic Mug");
    expect(p.description).toBe("Holds 12oz of coffee.");
    // Price range carries the store's real currency — never a default.
    expect(p.priceMin).toEqual({ amount: "12.99", currencyCode: "EUR" });
    expect(p.priceMax).toEqual({ amount: "15.99", currencyCode: "EUR" });
    // Any purchasable variant → product is available.
    expect(p.availableForSale).toBe(true);
    expect(p.onlineStoreUrl).toBe(
      "https://test-shop.example.com/products/ceramic-mug",
    );
    expect(p.options).toEqual([{ name: "Size", values: ["Small", "Large"] }]);
    // Variant prices inherit the price-range currency (Shopify's variant
    // `price` is a bare decimal in the store currency).
    expect(p.variants).toEqual([
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
    ]);

    const body = JSON.parse(captures[0]!.body) as {
      query: string;
      variables: { q: string; n: number };
    };
    expect(body.query).toContain("query SearchProducts");
    expect(body.variables.q).toBe("mug");
    expect(body.variables.n).toBe(5);
  });

  it("collapses the single default variant and placeholder option to empty arrays", async () => {
    reset();
    const SEARCH_PAYLOAD = {
      data: {
        products: {
          nodes: [
            searchNode({
              description: null,
              options: [{ name: "Title", values: ["Default Title"] }],
              variants: {
                nodes: [
                  {
                    title: "Default Title",
                    availableForSale: false,
                    price: "12.99",
                  },
                ],
              },
            }),
          ],
        },
      },
    };
    const layer = buildLayer(
      httpFromSequence([() => respond(200, SEARCH_PAYLOAD)]),
    );
    const products = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "mug", 5),
        ),
        layer,
      ),
    );
    const p = products[0]!;
    // A null description passes through as null (no invented copy).
    expect(p.description).toBeNull();
    // "Title: Default Title" is Shopify's placeholder for no-options
    // products — pure noise to an agent, so it collapses away.
    expect(p.options).toEqual([]);
    expect(p.variants).toEqual([]);
    // …but its availability still feeds the product-level flag.
    expect(p.availableForSale).toBe(false);
  });

  it("filters out non-ACTIVE products so drafts and archived items never reach the agent", async () => {
    reset();
    const SEARCH_PAYLOAD = {
      data: {
        products: {
          nodes: [
            searchNode({ id: "gid://shopify/Product/10", status: "DRAFT" }),
            searchNode({ id: "gid://shopify/Product/11", status: "ACTIVE" }),
            searchNode({
              id: "gid://shopify/Product/12",
              status: "ARCHIVED",
            }),
          ],
        },
      },
    };
    const layer = buildLayer(
      httpFromSequence([() => respond(200, SEARCH_PAYLOAD)]),
    );
    const products = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "mug", 5),
        ),
        layer,
      ),
    );
    expect(products.map((p) => p.id)).toEqual(["gid://shopify/Product/11"]);
  });

  it("returns an empty array when there are no matches", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { products: { nodes: [] } } }),
      ]),
    );
    const products = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "nothing", 5),
        ),
        layer,
      ),
    );
    expect(products).toEqual([]);
  });

  it("truncates a very long description to a bounded length with an ellipsis", async () => {
    reset();
    const longDesc = "x".repeat(2000);
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              products: {
                nodes: [
                  searchNode({
                    id: "gid://shopify/Product/3",
                    title: "Wordy",
                    productType: null,
                    vendor: null,
                    description: longDesc,
                  }),
                ],
              },
            },
          }),
      ]),
    );
    const products = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "wordy", 5),
        ),
        layer,
      ),
    );
    expect(products[0]!.description!.length).toBeLessThan(longDesc.length);
    expect(products[0]!.description!.endsWith("…")).toBe(true);
  });

  it("clamps a non-positive limit up into Shopify's first window", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { products: { nodes: [] } } }),
      ]),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.searchProducts(tenantId, "x", 0),
        ),
        layer,
      ),
    );
    const body = JSON.parse(captures[0]!.body) as { variables: { n: number } };
    expect(body.variables.n).toBe(1);
  });
});

describe("ShopifyServiceLive — listRecentOrderPiiPresence (PCD probe)", () => {
  const recentOrders = (
    nodes: ReadonlyArray<unknown>,
  ): { data: { orders: { nodes: ReadonlyArray<unknown> } } } => ({
    data: { orders: { nodes } },
  });

  it("reports presence booleans (not values) when PII is returned", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(
            200,
            recentOrders([
              {
                name: "#1002",
                email: "buyer@example.com",
                shippingAddress: {
                  name: "Jane Doe",
                  address1: "123 Main",
                  city: "Brooklyn",
                },
              },
            ]),
          ),
      ]),
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.listRecentOrderPiiPresence(tenantId, 5),
        ),
        layer,
      ),
    );
    expect(out).toEqual([
      {
        orderName: "#1002",
        hasEmail: true,
        hasCustomerName: true,
        hasShippingAddress: true,
      },
    ]);
    // The query asked for recent orders, newest first.
    const body = JSON.parse(captures[0]!.body) as {
      query: string;
      variables: { n: number };
    };
    expect(body.query).toContain("query RecentOrdersPii");
    expect(body.variables.n).toBe(5);
  });

  it("flags redacted/empty PII fields as absent (the misconfig signal)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(
            200,
            recentOrders([
              {
                name: "#1003",
                email: null,
                shippingAddress: null,
              },
              {
                name: "#1004",
                email: "   ",
                shippingAddress: { name: "", address1: null, city: null },
              },
            ]),
          ),
      ]),
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.listRecentOrderPiiPresence(tenantId, 5),
        ),
        layer,
      ),
    );
    expect(out).toEqual([
      {
        orderName: "#1003",
        hasEmail: false,
        hasCustomerName: false,
        hasShippingAddress: false,
      },
      {
        orderName: "#1004",
        hasEmail: false,
        hasCustomerName: false,
        hasShippingAddress: false,
      },
    ]);
  });

  it("returns an empty list when the store has no orders", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, recentOrders([]))]),
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.listRecentOrderPiiPresence(tenantId, 5),
        ),
        layer,
      ),
    );
    expect(out).toEqual([]);
  });
});

describe("ShopifyServiceLive — error mapping", () => {
  const callOrder = (layer: Layer.Layer<ShopifyService>) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOrder(tenantId, OrderId("12345")),
        ),
        layer,
      ),
    );

  it("401 → ShopifyAuthFailed", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(401, "unauthorized")]),
    );
    const exit = await callOrder(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(ShopifyAuthFailed);
    }
  });

  it("429 → ShopifyRateLimited", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(429, "rate limited")]),
    );
    const exit = await callOrder(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(ShopifyRateLimited);
    }
  });

  it("500 → NetworkError", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(500, "server error")]),
    );
    const exit = await callOrder(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(NetworkError);
    }
  });

  it("GraphQL errors array → NetworkError (response-invalid)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { errors: [{ message: "Field 'foo' missing" }] }),
      ]),
    );
    const exit = await callOrder(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(NetworkError);
    }
  });
});

// ============================================================
// refundOrder
// ============================================================

describe("ShopifyServiceLive — refundOrder", () => {
  const orderGid = "gid://shopify/Order/77777";

  const txPayload = (currencyCode = "USD") => ({
    data: {
      order: {
        currencyCode,
        transactions: [
          // First entry intentionally ineligible — verifies the picker
          // skips non-SUCCESS / non-SALE rows instead of just grabbing
          // transactions[0].
          {
            id: "gid://shopify/OrderTransaction/9",
            kind: "AUTHORIZATION",
            status: "SUCCESS",
            gateway: "manual",
            parentTransaction: null,
            amountSet: {
              shopMoney: { amount: "29.99", currencyCode },
            },
          },
          {
            id: "gid://shopify/OrderTransaction/10",
            kind: "SALE",
            status: "SUCCESS",
            gateway: "shopify_payments",
            parentTransaction: null,
            amountSet: {
              shopMoney: { amount: "29.99", currencyCode },
            },
          },
        ],
      },
    },
  });

  const refundOkPayload = {
    data: {
      refundCreate: {
        refund: {
          id: "gid://shopify/Refund/abc",
          createdAt: "2026-05-21T12:00:00.000Z",
          note: "Customer-requested refund",
          totalRefundedSet: {
            shopMoney: { amount: "20.00", currencyCode: "USD" },
          },
        },
        userErrors: [],
      },
    },
  };

  const callRefund = (
    layer: Layer.Layer<ShopifyService>,
    amount = "20.00",
    currencyCode = "USD",
  ) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.refundOrder(tenantId, {
            orderId: OrderId(orderGid),
            amount: { amount, currencyCode },
            note: "Customer-requested refund",
            notifyCustomer: true,
            idempotencyKey: "call-1",
          }),
        ),
        layer,
      ),
    );

  it("happy path: fetches transactions, calls refundCreate, maps the result", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () => respond(200, refundOkPayload),
      ]),
    );
    const exit = await callRefund(layer);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(captures.length).toBe(2);

    // Second call is the refundCreate mutation. Inspect the body to
    // confirm the parent transaction id + gateway were threaded
    // through and `kind: "REFUND"` was set.
    const body = JSON.parse(captures[1]!.body) as {
      variables: { input: Record<string, unknown> };
    };
    const input = body.variables.input;
    expect(input["orderId"]).toBe(orderGid);
    expect(input["note"]).toBe("Customer-requested refund");
    expect(input["notify"]).toBe(true);
    const tx0 = (input["transactions"] as ReadonlyArray<Record<string, unknown>>)[0]!;
    expect(tx0["parentId"]).toBe("gid://shopify/OrderTransaction/10");
    expect(tx0["gateway"]).toBe("shopify_payments");
    expect(tx0["kind"]).toBe("REFUND");
    expect(tx0["amount"]).toBe("20.00");

    if (Exit.isSuccess(exit)) {
      expect(exit.value.id).toBe("gid://shopify/Refund/abc");
      expect(exit.value.amount).toEqual({
        amount: "20.00",
        currencyCode: "USD",
      });
    }
  });

  it("currency mismatch → RefundFailed (no mutation called)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, txPayload("EUR"))]),
    );
    const exit = await callRefund(layer, "20.00", "USD");
    expect(Exit.isFailure(exit)).toBe(true);
    expect(captures.length).toBe(1); // mutation NOT called
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(RefundFailed);
      if (err instanceof RefundFailed) {
        expect(err.code).toBe("CURRENCY_MISMATCH");
      }
    }
  });

  it("no refundable transaction → RefundFailed NO_REFUNDABLE_TRANSACTION", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              order: {
                currencyCode: "USD",
                // Only PENDING + VOIDED — neither qualifies.
                transactions: [
                  {
                    id: "gid://shopify/OrderTransaction/11",
                    kind: "SALE",
                    status: "PENDING",
                    gateway: "shopify_payments",
                    parentTransaction: null,
                    amountSet: {
                      shopMoney: { amount: "29.99", currencyCode: "USD" },
                    },
                  },
                ],
              },
            },
          }),
      ]),
    );
    const exit = await callRefund(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(RefundFailed);
      if (err instanceof RefundFailed) {
        expect(err.code).toBe("NO_REFUNDABLE_TRANSACTION");
      }
    }
  });

  it("userErrors in refundCreate → RefundFailed with code + message", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () =>
          respond(200, {
            data: {
              refundCreate: {
                refund: null,
                userErrors: [
                  {
                    field: ["transactions"],
                    message: "Refund amount exceeds remaining refundable amount",
                    code: "TRANSACTION_AMOUNT_EXCEEDED",
                  },
                ],
              },
            },
          }),
      ]),
    );
    const exit = await callRefund(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(RefundFailed);
      if (err instanceof RefundFailed) {
        expect(err.code).toBe("TRANSACTION_AMOUNT_EXCEEDED");
        expect(err.message).toContain("exceeds");
      }
    }
  });

  it("unknown order → OrderNotFound (consistent with getOrder)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, { data: { order: null } })]),
    );
    const exit = await callRefund(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(OrderNotFound);
    }
  });
});
