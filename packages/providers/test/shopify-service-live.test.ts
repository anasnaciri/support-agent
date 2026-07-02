import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  CustomerId,
  CustomerNotFound,
  DiscountFailed,
  NetworkError,
  OrderCancelFailed,
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
      confirmationNumber: "XPAV284CT",
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

describe("ShopifyServiceLive — getOnlineStorePages", () => {
  it("queries pages and maps title, handle, body, isPublished", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              pages: {
                nodes: [
                  {
                    title: "FAQ",
                    handle: "faq",
                    body: "<p>Answers.</p>",
                    isPublished: true,
                  },
                  {
                    title: "Drafty",
                    handle: "drafty",
                    body: "<p>WIP.</p>",
                    isPublished: false,
                  },
                ],
              },
            },
          }),
      ]),
    );
    const pages = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOnlineStorePages(tenantId),
        ),
        layer,
      ),
    );
    // The service reports pages as-is (including unpublished, flagged) —
    // publication filtering is the importer's policy decision.
    expect(pages).toEqual([
      { title: "FAQ", handle: "faq", body: "<p>Answers.</p>", isPublished: true },
      {
        title: "Drafty",
        handle: "drafty",
        body: "<p>WIP.</p>",
        isPublished: false,
      },
    ]);
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0]!.body) as { query: string };
    expect(body.query).toContain("query OnlineStorePages");
  });

  it("returns an empty array when the store has no pages", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { pages: { nodes: [] } } }),
      ]),
    );
    const pages = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOnlineStorePages(tenantId),
        ),
        layer,
      ),
    );
    expect(pages).toEqual([]);
  });
});

describe("ShopifyServiceLive — listPickupLocations", () => {
  it("returns only pickup-enabled locations and never raw warehouses", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              locations: {
                nodes: [
                  {
                    name: "Downtown store",
                    localPickupSettingsV2: {
                      instructions: "Ring the bell at the side entrance.",
                    },
                    address: {
                      address1: "1 Main St",
                      address2: null,
                      city: "Berlin",
                      province: null,
                      country: "Germany",
                      zip: "10115",
                      phone: "+49 30 1234",
                    },
                  },
                  {
                    // A fulfillment warehouse: no local-pickup settings.
                    // Must NEVER surface — this is the privacy boundary.
                    name: "3PL warehouse",
                    localPickupSettingsV2: null,
                    address: {
                      address1: "Industriestr. 99",
                      address2: null,
                      city: "Leipzig",
                      province: null,
                      country: "Germany",
                      zip: "04103",
                      phone: null,
                    },
                  },
                ],
              },
            },
          }),
      ]),
    );
    const locations = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.listPickupLocations(tenantId),
        ),
        layer,
      ),
    );
    expect(locations).toEqual([
      {
        name: "Downtown store",
        instructions: "Ring the bell at the side entrance.",
        address1: "1 Main St",
        address2: null,
        city: "Berlin",
        province: null,
        country: "Germany",
        zip: "10115",
        phone: "+49 30 1234",
      },
    ]);
    expect(captures).toHaveLength(1);
    const body = JSON.parse(captures[0]!.body) as { query: string };
    expect(body.query).toContain("query PickupLocations");
    // Inactive locations are excluded at the query level.
    expect(body.query).toContain("includeInactive: false");
  });

  it("returns an empty array when no location offers pickup", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              locations: {
                nodes: [
                  {
                    name: "Warehouse",
                    localPickupSettingsV2: null,
                    address: {
                      address1: null,
                      address2: null,
                      city: null,
                      province: null,
                      country: null,
                      zip: null,
                      phone: null,
                    },
                  },
                ],
              },
            },
          }),
      ]),
    );
    const locations = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.listPickupLocations(tenantId),
        ),
        layer,
      ),
    );
    expect(locations).toEqual([]);
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

  // Confirmation-number fallback: customers who only have the alphanumeric
  // code from their confirmation email reach `findOrderByConfirmationNumber`,
  // which uses Shopify's `orders` query with `query: "confirmation_number:X"`.
  it("findOrderByConfirmationNumber issues a confirmation_number search and maps the result", async () => {
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
          s.findOrderByConfirmationNumber(tenantId, "XPAV284CT"),
        ),
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).not.toBeNull();
    expect(exit.value!.name).toBe("#1001");
    expect(exit.value!.confirmationNumber).toBe("XPAV284CT");

    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string };
    };
    expect(body.variables.q).toBe("confirmation_number:XPAV284CT");
  });

  it("findOrderByConfirmationNumber strips non-alphanumerics before building the query", async () => {
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
        // A pasted code with stray spaces / punctuation must not malform
        // the `confirmation_number:` filter.
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByConfirmationNumber(tenantId, "  XPAV-284 CT "),
        ),
        layer,
      ),
    );
    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string };
    };
    expect(body.variables.q).toBe("confirmation_number:XPAV284CT");
  });

  it("findOrderByConfirmationNumber short-circuits to null without an HTTP call when the code is empty after stripping", async () => {
    reset();
    const layer = buildLayer(httpFromSequence([]));
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByConfirmationNumber(tenantId, "###"),
        ),
        layer,
      ),
    );
    expect(result).toBeNull();
    expect(captures).toHaveLength(0);
  });

  it("findOrderByConfirmationNumber returns null on no match (not a typed error)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { orders: { nodes: [] } } }),
      ]),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrderByConfirmationNumber(tenantId, "ZZZ999"),
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

  // Backs `shopify.find_customer_order` — list a customer's orders by the
  // email they ordered under, most recent first, so a specialist can infer
  // the order when the case carries no order id.
  it("findOrdersByEmail issues an email search and maps every result", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () =>
          respond(200, {
            data: {
              orders: {
                nodes: [ORDER_PAYLOAD.data.order, ORDER_PAYLOAD.data.order],
              },
            },
          }),
      ]),
    );
    const orders = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrdersByEmail(tenantId, "customer@example.com", 10),
        ),
        layer,
      ),
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]!.name).toBe("#1001");
    const body = JSON.parse(captures[0]!.body) as {
      variables: { q: string; n: number };
    };
    expect(body.variables.q).toBe("email:customer@example.com");
    expect(body.variables.n).toBe(10);
  });

  it("findOrdersByEmail returns an empty array on no match", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, { data: { orders: { nodes: [] } } }),
      ]),
    );
    const orders = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrdersByEmail(tenantId, "nobody@example.com", 10),
        ),
        layer,
      ),
    );
    expect(orders).toEqual([]);
  });

  it("findOrdersByEmail short-circuits to [] without an HTTP call when the email is blank", async () => {
    reset();
    const layer = buildLayer(httpFromSequence([]));
    const orders = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.findOrdersByEmail(tenantId, "   ", 10),
        ),
        layer,
      ),
    );
    expect(orders).toEqual([]);
    expect(captures).toHaveLength(0);
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

  it("refundCreate mutation must not select `code` on userErrors (base UserError has none)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () => respond(200, refundOkPayload),
      ]),
    );
    await callRefund(layer);
    // Shopify's `refundCreate.userErrors` is the base `UserError` type,
    // which exposes only `field` and `message`. Selecting `code` makes
    // Shopify reject the WHOLE mutation with a top-level GraphQL error,
    // which `runQuery` surfaces as a generic NetworkError → HTTP 502.
    // (Unlike discountCodeBasicCreate / orderCancel, whose richer error
    // types DO carry `code`.)
    const mutation = (JSON.parse(captures[1]!.body) as { query: string }).query;
    expect(mutation).toContain("userErrors");
    expect(mutation).not.toMatch(/userErrors\s*{[^}]*\bcode\b/);
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

  it("userErrors in refundCreate → RefundFailed with message (base UserError has no code)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () =>
          respond(200, {
            data: {
              refundCreate: {
                refund: null,
                // Base `UserError`: field + message only, no `code`.
                userErrors: [
                  {
                    field: ["transactions"],
                    message: "Refund amount exceeds remaining refundable amount",
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
        expect(err.code).toBeNull();
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

  it("threads refundLineItems + shipping into the RefundInput when supplied", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () => respond(200, refundOkPayload),
      ]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.refundOrder(tenantId, {
            orderId: OrderId(orderGid),
            amount: { amount: "20.00", currencyCode: "USD" },
            note: "Dashboard refund",
            notifyCustomer: true,
            idempotencyKey: "call-restock",
            lineItems: [
              {
                lineItemId: "gid://shopify/LineItem/1",
                quantity: 2,
                restockType: "RETURN",
                locationId: "gid://shopify/Location/5",
              },
              // NO_RESTOCK must NOT carry a locationId (Shopify rejects it).
              {
                lineItemId: "gid://shopify/LineItem/2",
                quantity: 1,
                restockType: "NO_RESTOCK",
                locationId: "gid://shopify/Location/5",
              },
              // Zero-quantity lines are dropped.
              {
                lineItemId: "gid://shopify/LineItem/3",
                quantity: 0,
                restockType: "RETURN",
                locationId: "gid://shopify/Location/5",
              },
            ],
            shipping: { amount: "4.99", currencyCode: "USD" },
          }),
        ),
        layer,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const input = (
      JSON.parse(captures[1]!.body) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    const rli = input["refundLineItems"] as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(rli).toHaveLength(2);
    expect(rli[0]).toEqual({
      lineItemId: "gid://shopify/LineItem/1",
      quantity: 2,
      restockType: "RETURN",
      locationId: "gid://shopify/Location/5",
    });
    expect(rli[1]).toEqual({
      lineItemId: "gid://shopify/LineItem/2",
      quantity: 1,
      restockType: "NO_RESTOCK",
    });
    expect(input["shipping"]).toEqual({ amount: "4.99" });
  });

  it("omits refundLineItems + shipping for an amount-only refund", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, txPayload()),
        () => respond(200, refundOkPayload),
      ]),
    );
    await callRefund(layer);
    const input = (
      JSON.parse(captures[1]!.body) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    expect(input["refundLineItems"]).toBeUndefined();
    expect(input["shipping"]).toBeUndefined();
  });
});

// ============================================================
// getOrderRefundContext
// ============================================================

describe("ShopifyServiceLive — getOrderRefundContext", () => {
  const orderGid = "gid://shopify/Order/12345";

  const contextPayload = {
    data: {
      order: {
        id: orderGid,
        name: "#1001",
        currencyCode: "USD",
        lineItems: {
          nodes: [
            {
              id: "gid://shopify/LineItem/1",
              title: "The Collection Snowboard: Hydrogen",
              sku: "snow-1",
              variantTitle: null,
              quantity: 2,
              refundableQuantity: 2,
              unfulfilledQuantity: 0,
              restockable: true,
              discountedUnitPriceSet: {
                shopMoney: { amount: "300.00", currencyCode: "USD" },
              },
              image: { url: "https://cdn/snow.png" },
            },
            // refundableQuantity 0 → filtered out of the modal.
            {
              id: "gid://shopify/LineItem/9",
              title: "Already refunded",
              sku: null,
              variantTitle: null,
              quantity: 1,
              refundableQuantity: 0,
              unfulfilledQuantity: 0,
              restockable: false,
              discountedUnitPriceSet: {
                shopMoney: { amount: "10.00", currencyCode: "USD" },
              },
              image: null,
            },
          ],
        },
        suggestedRefund: {
          subtotalSet: { shopMoney: { amount: "600.00", currencyCode: "USD" } },
          maximumRefundableSet: {
            shopMoney: { amount: "660.00", currencyCode: "USD" },
          },
          shipping: {
            amountSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
            maximumRefundableSet: {
              shopMoney: { amount: "9.99", currencyCode: "USD" },
            },
          },
          refundLineItems: [
            {
              lineItem: { id: "gid://shopify/LineItem/1" },
              quantity: 2,
              subtotalSet: {
                shopMoney: { amount: "600.00", currencyCode: "USD" },
              },
              totalTaxSet: {
                shopMoney: { amount: "60.00", currencyCode: "USD" },
              },
            },
          ],
          suggestedTransactions: [
            {
              gateway: "bogus",
              formattedGateway: "(For Testing) Bogus Gateway",
              amountSet: {
                shopMoney: { amount: "660.00", currencyCode: "USD" },
              },
            },
          ],
        },
      },
    },
  };

  const restockPayload = {
    data: {
      order: {
        suggestedRefund: {
          refundLineItems: [
            {
              lineItem: { id: "gid://shopify/LineItem/1" },
              restockType: "RETURN",
              location: { id: "gid://shopify/Location/5", name: "Shop location" },
            },
          ],
        },
      },
      locations: {
        nodes: [{ id: "gid://shopify/Location/5", name: "Shop location" }],
      },
    },
  };

  const callContext = (layer: Layer.Layer<ShopifyService>) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.getOrderRefundContext(tenantId, OrderId(orderGid)),
        ),
        layer,
      ),
    );

  it("maps suggestedRefund into per-unit pricing, shipping, gateway + restock", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, contextPayload),
        () => respond(200, restockPayload),
      ]),
    );
    const exit = await callContext(layer);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const ctx = exit.value;
    expect(ctx.orderName).toBe("#1001");
    expect(ctx.currencyCode).toBe("USD");
    expect(ctx.subtotal).toEqual({ amount: "600.00", currencyCode: "USD" });
    expect(ctx.maximumRefundable).toEqual({
      amount: "660.00",
      currencyCode: "USD",
    });
    expect(ctx.shippingRefundable).toEqual({
      amount: "9.99",
      currencyCode: "USD",
    });
    expect(ctx.paymentGateway).toBe("(For Testing) Bogus Gateway");
    expect(ctx.locations).toEqual([
      { id: "gid://shopify/Location/5", name: "Shop location" },
    ]);
    // refundableQuantity 0 line excluded.
    expect(ctx.lineItems).toHaveLength(1);
    const li = ctx.lineItems[0]!;
    expect(li.lineItemId).toBe("gid://shopify/LineItem/1");
    expect(li.imageUrl).toBe("https://cdn/snow.png");
    expect(li.refundableQuantity).toBe(2);
    // 600.00 subtotal / qty 2 = 300.00 per unit; 60.00 tax / 2 = 30.00.
    expect(li.unitPrice).toEqual({ amount: "300.00", currencyCode: "USD" });
    expect(li.unitTax).toEqual({ amount: "30.00", currencyCode: "USD" });
    expect(li.fulfilled).toBe(true);
    expect(li.restockable).toBe(true);
    expect(li.restockLocationId).toBe("gid://shopify/Location/5");
  });

  it("degrades gracefully when the restock leg fails (missing read_inventory)", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([
        () => respond(200, contextPayload),
        () => respond(403, { errors: [{ message: "access denied" }] }),
      ]),
    );
    const exit = await callContext(layer);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const ctx = exit.value;
    // Core pricing still present; restock context simply empty.
    expect(ctx.lineItems).toHaveLength(1);
    expect(ctx.lineItems[0]!.unitPrice.amount).toBe("300.00");
    expect(ctx.locations).toEqual([]);
    expect(ctx.lineItems[0]!.restockLocationId).toBeNull();
  });

  it("unknown order → OrderNotFound", async () => {
    reset();
    const layer = buildLayer(
      httpFromSequence([() => respond(200, { data: { order: null } })]),
    );
    const exit = await callContext(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(OrderNotFound);
    }
  });
});

// ============================================================
// createDiscountCode
// ============================================================

describe("ShopifyServiceLive — createDiscountCode", () => {
  const customerGid = "gid://shopify/Customer/777";
  const endsAt = new Date("2026-07-25T00:00:00.000Z");

  const okPayload = (code = "THANKS-AB23CD") => ({
    data: {
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: "gid://shopify/DiscountCodeNode/99",
          codeDiscount: {
            title: "Goodwill discount",
            startsAt: "2026-06-25T00:00:00.000Z",
            endsAt: endsAt.toISOString(),
            usageLimit: 1,
            appliesOncePerCustomer: true,
            codes: { nodes: [{ code }] },
            customerGets: { value: { percentage: 0.15 } },
          },
        },
        userErrors: [],
      },
    },
  });

  const callCreate = (
    layer: Layer.Layer<ShopifyService>,
    overrides: Partial<{
      valueType: "percentage" | "fixed_amount";
      value: string;
      currencyCode: string | null;
    }> = {},
  ) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.createDiscountCode(tenantId, {
            customerId: CustomerId(customerGid),
            code: "THANKS-AB23CD",
            title: "Goodwill discount",
            valueType: overrides.valueType ?? "percentage",
            value: overrides.value ?? "15",
            currencyCode:
              overrides.currencyCode === undefined
                ? null
                : overrides.currencyCode,
            endsAt,
            usageLimit: 1,
            appliesOncePerCustomer: true,
          }),
        ),
        layer,
      ),
    );

  it("converts whole-percent to Shopify's 0..1 fraction and forces the guardrails", async () => {
    reset();
    const layer = buildLayer(httpFromSequence([() => respond(200, okPayload())]));
    const exit = await callCreate(layer);
    expect(Exit.isSuccess(exit)).toBe(true);

    const body = JSON.parse(captures[0]!.body) as {
      variables: { basicCodeDiscount: Record<string, unknown> };
    };
    const d = body.variables.basicCodeDiscount;
    // 15% → 0.15 fraction.
    const customerGets = d["customerGets"] as Record<string, unknown>;
    expect((customerGets["value"] as Record<string, unknown>)["percentage"]).toBe(
      0.15,
    );
    // Locked to exactly the one customer.
    const sel = d["customerSelection"] as Record<string, unknown>;
    expect((sel["customers"] as Record<string, unknown>)["add"]).toEqual([
      customerGid,
    ]);
    // Forced guardrails.
    expect(d["usageLimit"]).toBe(1);
    expect(d["appliesOncePerCustomer"]).toBe(true);
    expect(d["endsAt"]).toBe(endsAt.toISOString());
    expect(d["combinesWith"]).toEqual({
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    });
    expect(customerGets["items"]).toEqual({ all: true });

    if (Exit.isSuccess(exit)) {
      // Canonical value is the input (no round-trip through the float).
      expect(exit.value.value).toBe("15");
      expect(exit.value.valueType).toBe("percentage");
      expect(exit.value.code).toBe("THANKS-AB23CD");
      expect(exit.value.usageLimit).toBe(1);
    }
  });

  it("sends a fixed_amount as a discountAmount in the order currency", async () => {
    reset();
    const fixedPayload = {
      data: {
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/100",
            codeDiscount: {
              title: "Goodwill discount",
              startsAt: "2026-06-25T00:00:00.000Z",
              endsAt: endsAt.toISOString(),
              usageLimit: 1,
              appliesOncePerCustomer: true,
              codes: { nodes: [{ code: "THANKS-AB23CD" }] },
              customerGets: {
                value: { amount: { amount: "5.00", currencyCode: "USD" } },
              },
            },
          },
          userErrors: [],
        },
      },
    };
    const layer = buildLayer(httpFromSequence([() => respond(200, fixedPayload)]));
    const exit = await callCreate(layer, {
      valueType: "fixed_amount",
      value: "5.00",
      currencyCode: "USD",
    });
    expect(Exit.isSuccess(exit)).toBe(true);
    const body = JSON.parse(captures[0]!.body) as {
      variables: { basicCodeDiscount: Record<string, unknown> };
    };
    const value = (
      body.variables.basicCodeDiscount["customerGets"] as Record<string, unknown>
    )["value"] as Record<string, unknown>;
    expect(value["discountAmount"]).toEqual({
      amount: "5.00",
      appliesOnEachItem: false,
    });
  });

  it("maps userErrors → DiscountFailed", async () => {
    reset();
    const errPayload = {
      data: {
        discountCodeBasicCreate: {
          codeDiscountNode: null,
          userErrors: [
            { field: ["code"], code: "TAKEN", message: "Code already exists" },
          ],
        },
      },
    };
    const layer = buildLayer(httpFromSequence([() => respond(200, errPayload)]));
    const exit = await callCreate(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(DiscountFailed);
    }
  });
});

// ============================================================
// cancelOrder
// ============================================================

describe("ShopifyServiceLive — cancelOrder", () => {
  const orderGid = "gid://shopify/Order/12345";

  const callCancel = (
    layer: Layer.Layer<ShopifyService>,
    restock = true,
  ) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(ShopifyService, (s) =>
          s.cancelOrder(tenantId, {
            orderId: OrderId(orderGid),
            reason: "customer",
            refund: true,
            restock,
            notifyCustomer: false,
            staffNote: "Customer changed their mind",
            idempotencyKey: "call_1",
          }),
        ),
        layer,
      ),
    );

  it("happy path: maps the domain reason to the enum and returns the job id", async () => {
    reset();
    const okPayload = {
      data: {
        orderCancel: {
          job: { id: "gid://shopify/Job/abc" },
          orderCancelUserErrors: [],
        },
      },
    };
    const layer = buildLayer(httpFromSequence([() => respond(200, okPayload)]));
    const exit = await callCancel(layer, true);
    expect(Exit.isSuccess(exit)).toBe(true);

    const body = JSON.parse(captures[0]!.body) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables["orderId"]).toBe(orderGid);
    // Domain "customer" → Shopify's OrderCancelReason "CUSTOMER".
    expect(body.variables["reason"]).toBe("CUSTOMER");
    expect(body.variables["refund"]).toBe(true);
    expect(body.variables["restock"]).toBe(true);
    expect(body.variables["notifyCustomer"]).toBe(false);
    expect(body.variables["staffNote"]).toBe("Customer changed their mind");

    if (Exit.isSuccess(exit)) {
      expect(exit.value.orderId).toBe(orderGid);
      expect(exit.value.jobId).toBe("gid://shopify/Job/abc");
      expect(exit.value.accepted).toBe(true);
    }
  });

  it("passes restock=false through to the mutation", async () => {
    reset();
    const okPayload = {
      data: {
        orderCancel: { job: { id: "gid://shopify/Job/abc" }, orderCancelUserErrors: [] },
      },
    };
    const layer = buildLayer(httpFromSequence([() => respond(200, okPayload)]));
    await callCancel(layer, false);
    const body = JSON.parse(captures[0]!.body) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables["restock"]).toBe(false);
  });

  it("maps orderCancelUserErrors → OrderCancelFailed", async () => {
    reset();
    const errPayload = {
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [
            {
              field: ["orderId"],
              code: "CANT_CANCEL",
              message: "Order has already been fulfilled",
            },
          ],
        },
      },
    };
    const layer = buildLayer(httpFromSequence([() => respond(200, errPayload)]));
    const exit = await callCancel(layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error: unknown }).error;
      expect(err).toBeInstanceOf(OrderCancelFailed);
      if (err instanceof OrderCancelFailed) {
        expect(err.code).toBe("CANT_CANCEL");
        expect(err.message).toBe("Order has already been fulfilled");
      }
    }
  });
});
