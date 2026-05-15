import { Context, Effect, Layer } from "effect";
import {
  type CustomerId,
  type OrderId,
  type ShopifyAddress,
  type ShopifyCustomer,
  type ShopifyError,
  type ShopifyFinancialStatus,
  type ShopifyFulfillment,
  type ShopifyFulfillmentStatus,
  type ShopifyLineItem,
  type ShopifyMoney,
  type ShopifyOrder,
  type TenantId,
  CustomerId as makeCustomerId,
  CustomerNotFound,
  NetworkError,
  OrderId as makeOrderId,
  OrderNotFound,
  ShopifyAuthFailed,
  ShopifyRateLimited,
} from "@support-agent/agent-core";
import {
  ShopifyCredentialStore,
  ShopifyService,
  type ShopifyCredentials,
} from "@support-agent/services";

// ============================================================
// HTTP client Tag (overridable for tests)
// ============================================================

/**
 * Indirection over `fetch` so unit tests can swap in a deterministic
 * client without `vi.stubGlobal`. The Live default uses the platform
 * `fetch`; tests provide `ShopifyHttpClientFromFn(...)`.
 */
export type ShopifyHttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export class ShopifyHttp extends Context.Tag("ShopifyHttp")<
  ShopifyHttp,
  ShopifyHttpClient
>() {}

export const ShopifyHttpLive = Layer.succeed(
  ShopifyHttp,
  (url, init) => fetch(url, init) as unknown as ReturnType<ShopifyHttpClient>,
);

export const ShopifyHttpFromFn = (fn: ShopifyHttpClient) =>
  Layer.succeed(ShopifyHttp, fn);

// ============================================================
// Credential store from env (single-tenant dev stub)
// ============================================================

/**
 * Dev/test credential store. Returns the same credentials for every
 * tenant id, sourced from env. Fails the Layer build if required vars
 * are missing — better to crash at startup than discover at first call.
 */
export const ShopifyCredentialStoreFromEnv = Layer.effect(
  ShopifyCredentialStore,
  Effect.sync(() => {
    const shopDomain = process.env["SHOPIFY_TEST_SHOP_DOMAIN"];
    const accessToken = process.env["SHOPIFY_TEST_ACCESS_TOKEN"];
    if (!shopDomain || !accessToken) {
      throw new Error(
        "SHOPIFY_TEST_SHOP_DOMAIN and SHOPIFY_TEST_ACCESS_TOKEN are required for ShopifyCredentialStoreFromEnv",
      );
    }
    const apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2025-01";
    const creds: ShopifyCredentials = { shopDomain, accessToken, apiVersion };
    return ShopifyCredentialStore.of({
      get: () => Effect.succeed(creds),
    });
  }),
);

// ============================================================
// GraphQL helpers
// ============================================================

const endpoint = (c: ShopifyCredentials): string =>
  `https://${c.shopDomain}/admin/api/${c.apiVersion}/graphql.json`;

type GraphQLResponse<T> = {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{
    readonly message: string;
    readonly extensions?: { readonly code?: string };
  }>;
};

class ShopifyResponseInvalid {
  readonly _tag = "ShopifyResponseInvalid";
  constructor(readonly message: string) {}
}

const runQuery = <T>(
  http: ShopifyHttpClient,
  creds: ShopifyCredentials,
  tenantId: TenantId,
  query: string,
  variables: Record<string, unknown>,
): Effect.Effect<T, ShopifyError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await http(endpoint(creds), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": creds.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAuthFailed({ tenantId });
      }
      if (res.status === 429) {
        const retryAfter = 1000;
        throw new ShopifyRateLimited({ retryAfterMs: retryAfter });
      }
      if (!res.ok) {
        throw new NetworkError({
          cause: `Shopify HTTP ${res.status}: ${await res.text()}`,
        });
      }
      const payload = (await res.json()) as GraphQLResponse<T>;
      if (payload.errors && payload.errors.length > 0) {
        const msg = payload.errors.map((e) => e.message).join("; ");
        throw new ShopifyResponseInvalid(msg);
      }
      if (!payload.data) {
        throw new ShopifyResponseInvalid("Shopify response missing data");
      }
      return payload.data;
    },
    catch: (cause): ShopifyError => {
      if (
        cause instanceof ShopifyAuthFailed ||
        cause instanceof ShopifyRateLimited ||
        cause instanceof NetworkError
      ) {
        return cause;
      }
      return new NetworkError({ cause });
    },
  });

// ============================================================
// GID helpers
// ============================================================

const orderGid = (id: OrderId): string =>
  id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`;

const customerGid = (id: CustomerId): string =>
  id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;

// ============================================================
// Response mappers
// ============================================================

type GqlMoney = { readonly amount: string; readonly currencyCode: string };
type GqlAddress = {
  readonly name: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly zip: string | null;
  readonly phone: string | null;
} | null;

const mapMoney = (m: GqlMoney): ShopifyMoney => ({
  amount: m.amount,
  currencyCode: m.currencyCode,
});

const mapAddress = (a: GqlAddress): ShopifyAddress | null =>
  a
    ? {
        name: a.name,
        address1: a.address1,
        address2: a.address2,
        city: a.city,
        province: a.province,
        country: a.country,
        zip: a.zip,
        phone: a.phone,
      }
    : null;

const mapFulfillmentStatus = (
  s: string | null | undefined,
): ShopifyFulfillmentStatus | null => {
  if (!s) return null;
  const lower = s.toLowerCase();
  const known: ReadonlyArray<ShopifyFulfillmentStatus> = [
    "unfulfilled",
    "partial",
    "fulfilled",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "attempted_delivery",
    "failure",
    "restocked",
  ];
  return (known.find((k) => k === lower) ?? null) as
    | ShopifyFulfillmentStatus
    | null;
};

const mapFinancialStatus = (
  s: string | null | undefined,
): ShopifyFinancialStatus | null => {
  if (!s) return null;
  const lower = s.toLowerCase();
  const known: ReadonlyArray<ShopifyFinancialStatus> = [
    "pending",
    "authorized",
    "partially_paid",
    "paid",
    "partially_refunded",
    "refunded",
    "voided",
  ];
  return (known.find((k) => k === lower) ?? null) as
    | ShopifyFinancialStatus
    | null;
};

type GqlFulfillment = {
  readonly id: string;
  readonly displayStatus?: string | null;
  readonly status?: string | null;
  readonly trackingInfo: ReadonlyArray<{
    readonly company: string | null;
    readonly number: string | null;
    readonly url: string | null;
  }>;
  readonly estimatedDeliveryAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const mapFulfillment = (f: GqlFulfillment): ShopifyFulfillment => {
  const status =
    mapFulfillmentStatus(f.displayStatus ?? f.status) ?? "fulfilled";
  const trackingCompany =
    f.trackingInfo.find((t) => t.company !== null)?.company ?? null;
  const trackingNumbers = f.trackingInfo
    .map((t) => t.number)
    .filter((n): n is string => n !== null);
  const trackingUrls = f.trackingInfo
    .map((t) => t.url)
    .filter((u): u is string => u !== null);
  return {
    id: f.id,
    status,
    trackingCompany,
    trackingNumbers,
    trackingUrls,
    estimatedDeliveryAt: f.estimatedDeliveryAt
      ? new Date(f.estimatedDeliveryAt)
      : null,
    deliveredAt: f.deliveredAt ? new Date(f.deliveredAt) : null,
    createdAt: new Date(f.createdAt),
    updatedAt: new Date(f.updatedAt),
  };
};

type GqlOrder = {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly customer: { readonly id: string } | null;
  readonly displayFulfillmentStatus: string | null;
  readonly displayFinancialStatus: string | null;
  readonly totalPriceSet: { readonly shopMoney: GqlMoney };
  readonly shippingAddress: GqlAddress;
  readonly lineItems: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly quantity: number;
      readonly sku: string | null;
      readonly variantTitle: string | null;
    }>;
  };
  readonly fulfillments: ReadonlyArray<GqlFulfillment>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const mapOrder = (o: GqlOrder): ShopifyOrder => ({
  id: makeOrderId(o.id),
  name: o.name,
  email: o.email,
  customerId: o.customer ? makeCustomerId(o.customer.id) : null,
  fulfillmentStatus: mapFulfillmentStatus(o.displayFulfillmentStatus),
  financialStatus: mapFinancialStatus(o.displayFinancialStatus),
  totalPrice: mapMoney(o.totalPriceSet.shopMoney),
  shippingAddress: mapAddress(o.shippingAddress),
  lineItems: o.lineItems.nodes.map(
    (n): ShopifyLineItem => ({
      id: n.id,
      title: n.title,
      quantity: n.quantity,
      sku: n.sku,
      variantTitle: n.variantTitle,
    }),
  ),
  fulfillments: o.fulfillments.map(mapFulfillment),
  createdAt: new Date(o.createdAt),
  updatedAt: new Date(o.updatedAt),
});

type GqlCustomer = {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly numberOfOrders: string;
  readonly amountSpent: GqlMoney;
  readonly defaultAddress: GqlAddress;
  readonly createdAt: string;
};

const mapCustomer = (c: GqlCustomer): ShopifyCustomer => ({
  id: makeCustomerId(c.id),
  email: c.email,
  firstName: c.firstName,
  lastName: c.lastName,
  phone: c.phone,
  ordersCount: Number.parseInt(c.numberOfOrders, 10),
  totalSpent: mapMoney(c.amountSpent),
  defaultAddress: mapAddress(c.defaultAddress),
  createdAt: new Date(c.createdAt),
});

// ============================================================
// Queries
// ============================================================

const ORDER_FIELDS = `
  id
  name
  email
  customer { id }
  displayFulfillmentStatus
  displayFinancialStatus
  totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress {
    name address1 address2 city province country zip phone
  }
  lineItems(first: 50) {
    nodes { id title quantity sku variantTitle }
  }
  fulfillments(first: 20) {
    id
    displayStatus
    status
    trackingInfo { company number url }
    estimatedDeliveryAt
    deliveredAt
    createdAt
    updatedAt
  }
  createdAt
  updatedAt
`;

const CUSTOMER_FIELDS = `
  id
  email
  firstName
  lastName
  phone
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultAddress {
    name address1 address2 city province country zip phone
  }
  createdAt
`;

const GET_ORDER_QUERY = `
  query GetOrder($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

const GET_CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) { ${CUSTOMER_FIELDS} }
  }
`;

const SEARCH_CUSTOMER_QUERY = `
  query SearchCustomer($q: String!) {
    customers(first: 1, query: $q) {
      nodes { ${CUSTOMER_FIELDS} }
    }
  }
`;

const GET_FULFILLMENT_QUERY = `
  query GetFulfillments($id: ID!) {
    order(id: $id) {
      fulfillments(first: 20) {
        id
        displayStatus
        status
        trackingInfo { company number url }
        estimatedDeliveryAt
        deliveredAt
        createdAt
        updatedAt
      }
    }
  }
`;

// ============================================================
// Live Layer
// ============================================================

export const ShopifyServiceLive = Layer.effect(
  ShopifyService,
  Effect.gen(function* () {
    const http = yield* ShopifyHttp;
    const store = yield* ShopifyCredentialStore;

    const withCreds = <T>(
      tenantId: TenantId,
      fn: (creds: ShopifyCredentials) => Effect.Effect<T, ShopifyError>,
    ): Effect.Effect<T, ShopifyError> =>
      Effect.flatMap(store.get(tenantId), fn);

    return ShopifyService.of({
      getOrder: (tenantId, orderId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{ order: GqlOrder | null }>(
            http,
            creds,
            tenantId,
            GET_ORDER_QUERY,
            { id: orderGid(orderId) },
          ).pipe(
            Effect.flatMap((data) =>
              data.order
                ? Effect.succeed(mapOrder(data.order))
                : Effect.fail(new OrderNotFound({ orderId })),
            ),
          ),
        ),

      getCustomer: (tenantId, customerId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{ customer: GqlCustomer | null }>(
            http,
            creds,
            tenantId,
            GET_CUSTOMER_QUERY,
            { id: customerGid(customerId) },
          ).pipe(
            Effect.flatMap((data) =>
              data.customer
                ? Effect.succeed(mapCustomer(data.customer))
                : Effect.fail(new CustomerNotFound({ query: customerId })),
            ),
          ),
        ),

      searchByEmail: (tenantId, email) =>
        withCreds(tenantId, (creds) =>
          runQuery<{ customers: { nodes: ReadonlyArray<GqlCustomer> } }>(
            http,
            creds,
            tenantId,
            SEARCH_CUSTOMER_QUERY,
            { q: `email:${email}` },
          ).pipe(
            Effect.map((data) => {
              const first = data.customers.nodes[0];
              return first ? mapCustomer(first) : null;
            }),
          ),
        ),

      getFulfillment: (tenantId, orderId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            order: { fulfillments: ReadonlyArray<GqlFulfillment> } | null;
          }>(http, creds, tenantId, GET_FULFILLMENT_QUERY, {
            id: orderGid(orderId),
          }).pipe(
            Effect.flatMap((data) =>
              data.order
                ? Effect.succeed(data.order.fulfillments.map(mapFulfillment))
                : Effect.fail(new OrderNotFound({ orderId })),
            ),
          ),
        ),
    });
  }),
);
