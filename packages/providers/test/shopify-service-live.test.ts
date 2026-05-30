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
