import { createHash } from "node:crypto";
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
  type ShopifyLocation,
  type ShopifyMoney,
  type ShopifyOrder,
  type ShopifyOrderCancellation,
  type ShopifyOrderRefundContext,
  type ShopifyRefundLineItem,
  type ShopifyProduct,
  type ShopifyProductImage,
  type ShopifyProductSearchResult,
  type ShopifyRefund,
  type ShopifyDiscount,
  type TenantId,
  CustomerId as makeCustomerId,
  CustomerNotFound,
  DiscountFailed,
  NetworkError,
  OrderCancelFailed,
  FulfillmentUpdateFailed,
  OrderUpdateFailed,
  OrderId as makeOrderId,
  OrderNotFound,
  ProductNotFound,
  RefundFailed,
  ShopifyAuthFailed,
  ShopifyRateLimited,
  ShopifyResponseInvalid,
} from "@support-agent/agent-core";
import {
  ShopifyCredentialStore,
  ShopifyService,
  type CancelOrderInput,
  type CreateDiscountCodeInput,
  type CustomerRefundHistory,
  type OrderPiiPresence,
  type ShopifyCredentials,
  type ShopPolicy,
  type RefundOrderInput,
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

/**
 * Wall-clock budget for a single Shopify Admin API call. `fetch` carries no
 * client-side timeout by default, so a hung request (slow `refundCreate`, a
 * stalled socket) would block the API/worker with nothing to cancel it and
 * eventually surface as an opaque gateway 502. `AbortSignal.timeout` cancels
 * it; the rejection is caught by `runQuery` and surfaces as a NetworkError.
 * Env override: `SHOPIFY_HTTP_TIMEOUT_MS`.
 */
export const DEFAULT_SHOPIFY_HTTP_TIMEOUT_MS = 20_000;
const MIN_SHOPIFY_HTTP_TIMEOUT_MS = 1_000;
const MAX_SHOPIFY_HTTP_TIMEOUT_MS = 120_000;

export const shopifyHttpTimeoutMs = (
  env: Record<string, string | undefined>,
): number => {
  const raw = env["SHOPIFY_HTTP_TIMEOUT_MS"];
  if (raw === undefined) return DEFAULT_SHOPIFY_HTTP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_SHOPIFY_HTTP_TIMEOUT_MS;
  return Math.max(
    MIN_SHOPIFY_HTTP_TIMEOUT_MS,
    Math.min(MAX_SHOPIFY_HTTP_TIMEOUT_MS, n),
  );
};

export const ShopifyHttpLive = Layer.succeed(
  ShopifyHttp,
  (url, init) =>
    fetch(url, {
      ...init,
      signal: AbortSignal.timeout(shopifyHttpTimeoutMs(process.env)),
    }) as unknown as ReturnType<ShopifyHttpClient>,
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
    const apiVersion = process.env["SHOPIFY_API_VERSION"] ?? "2026-04";
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
        throw new ShopifyResponseInvalid({ message: msg });
      }
      if (!payload.data) {
        throw new ShopifyResponseInvalid({
          message: "Shopify response missing data",
        });
      }
      return payload.data;
    },
    catch: (cause): ShopifyError => {
      // Preserve our already-typed errors verbatim — only a GENUINE transport
      // failure (fetch rejection, timeout, socket reset, JSON parse) falls
      // through to NetworkError. A top-level GraphQL error stays a
      // ShopifyResponseInvalid so it isn't mislabeled as "network".
      if (
        cause instanceof ShopifyAuthFailed ||
        cause instanceof ShopifyRateLimited ||
        cause instanceof ShopifyResponseInvalid ||
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

const productGid = (id: string): string =>
  id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;

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
  readonly confirmationNumber: string | null;
  readonly email: string | null;
  readonly customer: { readonly id: string } | null;
  readonly displayFulfillmentStatus: string | null;
  readonly displayFinancialStatus: string | null;
  readonly cancelledAt: string | null;
  readonly totalPriceSet: { readonly shopMoney: GqlMoney };
  readonly shippingAddress: GqlAddress;
  readonly lineItems: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly quantity: number;
      readonly sku: string | null;
      readonly variantTitle: string | null;
      readonly product: { readonly id: string } | null;
    }>;
  };
  readonly fulfillments: ReadonlyArray<GqlFulfillment>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const mapOrder = (o: GqlOrder): ShopifyOrder => ({
  id: makeOrderId(o.id),
  name: o.name,
  confirmationNumber: o.confirmationNumber ?? null,
  email: o.email,
  customerId: o.customer ? makeCustomerId(o.customer.id) : null,
  fulfillmentStatus: mapFulfillmentStatus(o.displayFulfillmentStatus),
  financialStatus: mapFinancialStatus(o.displayFinancialStatus),
  cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
  totalPrice: mapMoney(o.totalPriceSet.shopMoney),
  shippingAddress: mapAddress(o.shippingAddress),
  lineItems: o.lineItems.nodes.map(
    (n): ShopifyLineItem => ({
      id: n.id,
      title: n.title,
      quantity: n.quantity,
      sku: n.sku,
      variantTitle: n.variantTitle,
      productId: n.product ? n.product.id : null,
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

type GqlProduct = {
  readonly id: string;
  readonly title: string;
  readonly productType: string | null;
  readonly vendor: string | null;
  readonly images: {
    readonly nodes: ReadonlyArray<{
      readonly url: string;
      readonly altText: string | null;
    }>;
  };
};

const mapProduct = (p: GqlProduct): ShopifyProduct => ({
  id: p.id,
  title: p.title,
  productType: p.productType,
  vendor: p.vendor,
  images: p.images.nodes.map(
    (n): ShopifyProductImage => ({ url: n.url, altText: n.altText }),
  ),
});

type GqlMoneyV2 = {
  readonly amount: string;
  readonly currencyCode: string;
};

type GqlProductSearchNode = {
  readonly id: string;
  readonly title: string;
  readonly productType: string | null;
  readonly vendor: string | null;
  readonly description: string | null;
  readonly status: string;
  readonly onlineStoreUrl: string | null;
  readonly priceRangeV2: {
    readonly minVariantPrice: GqlMoneyV2;
    readonly maxVariantPrice: GqlMoneyV2;
  };
  readonly options: ReadonlyArray<{
    readonly name: string;
    readonly values: ReadonlyArray<string>;
  }>;
  readonly variants: {
    readonly nodes: ReadonlyArray<{
      readonly title: string;
      readonly availableForSale: boolean;
      // Admin API variant `price` is a bare decimal string in the store
      // currency — the currency code lives on the product's price range.
      readonly price: string;
    }>;
  };
};

// Keep product descriptions from blowing up the token budget when an
// agent searches the catalog: a few hundred chars is plenty to answer
// "do you sell X?" / "is it waterproof?", and we never want a multi-KB
// body landing in the prompt. Truncate on a char boundary with an
// ellipsis; collapse blank/whitespace-only descriptions to null so the
// agent treats "no description" uniformly.
const PRODUCT_DESCRIPTION_CAP = 600;
const truncateDescription = (d: string | null): string | null => {
  if (d === null) return null;
  const trimmed = d.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > PRODUCT_DESCRIPTION_CAP
    ? `${trimmed.slice(0, PRODUCT_DESCRIPTION_CAP)}…`
    : trimmed;
};

// Shopify models a no-options product as a single placeholder variant
// ("Title: Default Title"). That's noise to an agent — the price range and
// availability flag already say everything — so it collapses to empty
// options/variants in the mapped result.
const isDefaultPlaceholderVariants = (
  p: GqlProductSearchNode,
): boolean =>
  p.variants.nodes.length === 1 &&
  p.variants.nodes[0]!.title === "Default Title";

const mapProductSearchNode = (
  p: GqlProductSearchNode,
): ShopifyProductSearchResult => {
  // Variant `price` has no currency of its own; the store currency comes
  // from the product's price range (never a hardcoded default).
  const currencyCode = p.priceRangeV2.minVariantPrice.currencyCode;
  const collapse = isDefaultPlaceholderVariants(p);
  return {
    id: p.id,
    title: p.title,
    productType: p.productType,
    vendor: p.vendor,
    description: truncateDescription(p.description),
    priceMin: {
      amount: p.priceRangeV2.minVariantPrice.amount,
      currencyCode: p.priceRangeV2.minVariantPrice.currencyCode,
    },
    priceMax: {
      amount: p.priceRangeV2.maxVariantPrice.amount,
      currencyCode: p.priceRangeV2.maxVariantPrice.currencyCode,
    },
    availableForSale: p.variants.nodes.some((v) => v.availableForSale),
    onlineStoreUrl: p.onlineStoreUrl,
    options: collapse
      ? []
      : p.options.map((o) => ({ name: o.name, values: [...o.values] })),
    variants: collapse
      ? []
      : p.variants.nodes.map((v) => ({
          title: v.title,
          price: { amount: v.price, currencyCode },
          availableForSale: v.availableForSale,
        })),
  };
};

// ============================================================
// Queries
// ============================================================

const ORDER_FIELDS = `
  id
  name
  confirmationNumber
  email
  customer { id }
  displayFulfillmentStatus
  displayFinancialStatus
  cancelledAt
  totalPriceSet { shopMoney { amount currencyCode } }
  shippingAddress {
    name address1 address2 city province country zip phone
  }
  lineItems(first: 50) {
    nodes { id title quantity sku variantTitle product { id } }
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

const GET_PRODUCT_QUERY = `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      productType
      vendor
      images(first: 10) {
        nodes { url altText }
      }
    }
  }
`;

// Pre-sale grounding fields beyond the basics: price range (MoneyV2, the
// only place the store currency appears — variant `price` is a bare
// decimal), customer-facing `availableForSale` per variant (a boolean,
// never an inventory count — we deliberately don't request quantities),
// `onlineStoreUrl` (null when not published to the Online Store channel),
// and `status` so the mapper can drop DRAFT/ARCHIVED products a customer
// could never see. Variants capped at 10: the options matrix already
// conveys the full shape, and per-variant rows are token-expensive.
const SEARCH_PRODUCTS_QUERY = `
  query SearchProducts($q: String!, $n: Int!) {
    products(first: $n, query: $q) {
      nodes {
        id
        title
        productType
        vendor
        description
        status
        onlineStoreUrl
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        options { name values }
        variants(first: 10) {
          nodes { title availableForSale price }
        }
      }
    }
  }
`;

// Public store facts only. `contactEmail` is the customer-facing address;
// the bare `shop.email` field is the merchant's private account login and
// must never be selected here (a test pins this). `shipsToCountries`
// derives from the shipping zones; none of these fields need an extra
// OAuth scope beyond an active connection.
const SHOP_INFO_QUERY = `
  query ShopInfo {
    shop {
      name
      contactEmail
      currencyCode
      primaryDomain { url }
      shipsToCountries
    }
  }
`;

// `Shop.shopPolicies` is a plain list ([ShopPolicy!]!), not a connection —
// no `first`/`nodes` paging. `body` is HTML; `url` is the public policy page.
const SHOP_POLICIES_QUERY = `
  query ShopPolicies {
    shop {
      shopPolicies {
        type
        title
        body
        url
      }
    }
  }
`;

// Online Store pages for the post-connect KB import. 50 covers any real
// store's page count for our purposes — the importer only keeps the
// About/Contact/FAQ handful anyway. Needs `read_online_store_pages`.
const ONLINE_STORE_PAGES_QUERY = `
  query OnlineStorePages($n: Int!) {
    pages(first: $n) {
      nodes { title handle body isPublished }
    }
  }
`;

// Customer pickup points. `localPickupSettingsV2` is non-null exactly when
// the location has local pickup enabled — that's the customer-facing
// signal; everything else (warehouses, 3PLs, dropship origins) is filtered
// out in the mapper and never leaves the service. Needs `read_locations`.
const PICKUP_LOCATIONS_QUERY = `
  query PickupLocations {
    locations(first: 50, includeInactive: false) {
      nodes {
        name
        localPickupSettingsV2 { instructions }
        address {
          address1 address2 city province country zip phone
        }
      }
    }
  }
`;

const SEARCH_CUSTOMER_QUERY = `
  query SearchCustomer($q: String!) {
    customers(first: 1, query: $q) {
      nodes { ${CUSTOMER_FIELDS} }
    }
  }
`;

const SEARCH_ORDER_BY_NAME_QUERY = `
  query SearchOrderByName($q: String!) {
    orders(first: 1, query: $q) {
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

// Confirmation-number fallback search. Shopify's `orders` query supports a
// `confirmation_number:` filter; the code is alphanumeric so no quoting is
// needed (the service strips anything else before building `q`).
const SEARCH_ORDER_BY_CONFIRMATION_QUERY = `
  query SearchOrderByConfirmation($q: String!) {
    orders(first: 1, query: $q) {
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

// List a customer's orders by the email they ordered under, most recent
// first. Backs `findOrdersByEmail` / `shopify.find_customer_order`: the
// caller only needs enough rows to tell "exactly one" from "many", so the
// service caps `$n` low. Same `email:` filter the customer search uses.
const LIST_ORDERS_BY_EMAIL_QUERY = `
  query ListOrdersByEmail($q: String!, $n: Int!) {
    orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

// Orders belonging to ONE customer account, newest first — the identity-safe
// "which orders does this customer have?" lookup once a ticket has resolved the
// customer. Uses the customer node's orders connection (not a `customer_id:`
// filter) so it's exactly the account's orders.
const LIST_ORDERS_BY_CUSTOMER_QUERY = `
  query ListOrdersByCustomer($id: ID!, $n: Int!) {
    customer(id: $id) {
      orders(first: $n, sortKey: CREATED_AT, reverse: true) {
        nodes { ${ORDER_FIELDS} }
      }
    }
  }
`;

// PCD probe: pull the most recent orders and inspect the Level-2 PII
// fields most reliably present on a real order — `email` and the
// `shippingAddress`. A custom-distribution app that hasn't declared its
// protected customer data fields gets these silently redacted/nulled on
// live stores; reading a few recent orders and checking presence catches
// that misconfiguration. We select only the fields we test for.
const RECENT_ORDERS_PII_QUERY = `
  query RecentOrdersPii($n: Int!) {
    orders(first: $n, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        email
        shippingAddress { name address1 city }
      }
    }
  }
`;

// Aggregate refund history for a customer. Wide enough to catch power
// users (first 50 orders); narrow enough that one HTTP request covers
// the aggregation client-side. Each order is shallowly hydrated — we
// only need `createdAt` for the first-order timestamp and `refunds[]`
// to count + sum.
const GET_CUSTOMER_REFUND_HISTORY_QUERY = `
  query GetCustomerRefundHistory($id: ID!) {
    customer(id: $id) {
      id
      ordersCount {
        count
      }
      orders(first: 50, sortKey: CREATED_AT) {
        edges {
          node {
            id
            createdAt
            refunds {
              id
              totalRefundedSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
      }
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

// Used by refundOrder to find a parent transaction to refund against.
// `kind` of SALE or CAPTURE with status SUCCESS is what we can refund;
// we pick the first one we find. `maximumRefundableV2` tells us how
// much is left to refund on that transaction, which we use to surface
// a sharper error than "Shopify said no" when the request exceeds it.
const GET_ORDER_TRANSACTIONS_QUERY = `
  query GetOrderTransactions($id: ID!) {
    order(id: $id) {
      currencyCode
      transactions {
        id
        kind
        status
        gateway
        parentTransaction { id }
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

// NOTE: `refundCreate.userErrors` is Shopify's base `UserError` type, which
// exposes only `field` and `message` — it has NO `code` field (unlike
// `discountCodeBasicCreate` / `orderCancel`, whose richer error types do).
// Selecting `code` here makes Shopify reject the whole mutation with a
// top-level GraphQL error, which `runQuery` surfaces as a generic
// `NetworkError` → the dashboard's "refund_failed" / HTTP 502.
//
// The `@idempotent(key:)` directive is MANDATORY on refundCreate as of the
// Shopify Admin API 2026-04 (optional since 2026-01). Omitting it fails at
// runtime with "The @idempotent directive is required for this mutation but
// was not provided." — note it is NOT enforced at the schema level, so a
// codegen/schema validator won't catch its absence. We pass a deterministic
// UUID derived from the caller's idempotency key so a retry of the SAME refund
// reuses the SAME key and Shopify dedupes it (no double refund).
const REFUND_CREATE_MUTATION = `
  mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        id
        createdAt
        note
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

// `orderCancel` is async: Shopify queues the cancellation (and the optional
// refund + restock) and returns a `job` rather than the mutated order. The
// `reason` is a required `OrderCancelReason!` enum (CUSTOMER / DECLINED /
// FRAUD / INVENTORY / OTHER / STAFF); `refund`/`restock` are required
// booleans. Errors come back on `orderCancelUserErrors`, not the generic
// `userErrors` field. Gated by `write_orders`, same as `refundCreate`.
const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $refund: Boolean!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: $refund
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }
`;

type OrderCancelPayload = {
  readonly orderCancel: {
    readonly job: { readonly id: string } | null;
    readonly orderCancelUserErrors: ReadonlyArray<{
      readonly field: ReadonlyArray<string> | null;
      readonly message: string;
      readonly code: string | null;
    }>;
  };
};

// Replaces an order's shipping address (the dashboard's "edit Ship-to"
// pencil). `OrderInput.shippingAddress` is a whole-object replacement, so the
// caller sends the complete merged address. NOTE `orderUpdate.userErrors` is
// Shopify's base `UserError` — selecting `code` here would invalidate the
// whole mutation (same trap as `refundCreate` above). Gated by
// `write_orders`, same as `refundCreate`.
const ORDER_UPDATE_SHIPPING_ADDRESS_MUTATION = `
  mutation OrderUpdateShippingAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        shippingAddress {
          name address1 address2 city province country zip phone
        }
      }
      userErrors { field message }
    }
  }
`;

type OrderUpdatePayload = {
  readonly orderUpdate: {
    readonly order: {
      readonly id: string;
      readonly shippingAddress: GqlAddress;
    } | null;
    // Base `UserError` — `field` + `message` only (no `code`).
    readonly userErrors: ReadonlyArray<{
      readonly field: ReadonlyArray<string> | null;
      readonly message: string;
    }>;
  };
};

// Replaces a fulfillment's tracking info (the supplier portal's "fix the
// tracking number" edit). Selects the same fulfillment fields as
// GET_FULFILLMENT_QUERY so the payload reuses `mapFulfillment`. NOTE the
// payload's `userErrors` is Shopify's base `UserError` — selecting `code`
// would invalidate the whole mutation (same trap as `orderUpdate` above).
// Gated by `write_fulfillments`.
const FULFILLMENT_TRACKING_UPDATE_MUTATION = `
  mutation FulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        displayStatus
        status
        trackingInfo { company number url }
        estimatedDeliveryAt
        deliveredAt
        createdAt
        updatedAt
      }
      userErrors { field message }
    }
  }
`;

type FulfillmentTrackingUpdatePayload = {
  readonly fulfillmentTrackingInfoUpdate: {
    readonly fulfillment: GqlFulfillment | null;
    // Base `UserError` — `field` + `message` only (no `code`).
    readonly userErrors: ReadonlyArray<{
      readonly field: ReadonlyArray<string> | null;
      readonly message: string;
    }>;
  };
};

// `MailingAddressInput` has no single `name` field — split our domain's
// display name into firstName / lastName at the first space ("Mary Jane
// Watson" → "Mary" + "Jane Watson"). Shopify renders name as
// `firstName lastName`, so the display value round-trips.
const splitAddressName = (
  name: string | null,
): { readonly firstName?: string; readonly lastName?: string } => {
  const trimmed = name?.trim() ?? "";
  if (trimmed === "") return {};
  const spaceAt = trimmed.indexOf(" ");
  if (spaceAt === -1) return { firstName: trimmed };
  return {
    firstName: trimmed.slice(0, spaceAt),
    lastName: trimmed.slice(spaceAt + 1).trim(),
  };
};

type GqlTransaction = {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly gateway: string | null;
  readonly parentTransaction: { readonly id: string } | null;
  readonly amountSet: { readonly shopMoney: GqlMoney };
};

type RefundCreatePayload = {
  readonly refundCreate: {
    readonly refund: {
      readonly id: string;
      readonly createdAt: string;
      readonly note: string | null;
      readonly totalRefundedSet: { readonly shopMoney: GqlMoney };
    } | null;
    // Base `UserError` — `field` + `message` only (no `code`); see the note
    // on REFUND_CREATE_MUTATION.
    readonly userErrors: ReadonlyArray<{
      readonly field: ReadonlyArray<string> | null;
      readonly message: string;
    }>;
  };
};

// Backs `getOrderRefundContext`. `suggestedRefund(suggestFullRefund: true)` is
// Shopify's own refund-calculator — it returns the accurate per-line subtotals
// + tax, the refundable shipping, the maximum refundable, and the suggested
// gateway, exactly as the Shopify admin refund page uses. Needs only
// `read_orders` (the restock `location` + root `locations` are fetched
// separately and best-effort, because they additionally require
// `read_inventory`, which older installs may not have granted).
const ORDER_REFUND_CONTEXT_QUERY = `
  query OrderRefundContext($id: ID!) {
    order(id: $id) {
      id
      name
      currencyCode
      lineItems(first: 50) {
        nodes {
          id
          title
          sku
          variantTitle
          quantity
          refundableQuantity
          unfulfilledQuantity
          restockable
          discountedUnitPriceSet { shopMoney { amount currencyCode } }
          image { url }
        }
      }
      suggestedRefund(suggestFullRefund: true) {
        subtotalSet { shopMoney { amount currencyCode } }
        maximumRefundableSet { shopMoney { amount currencyCode } }
        shipping {
          amountSet { shopMoney { amount currencyCode } }
          maximumRefundableSet { shopMoney { amount currencyCode } }
        }
        refundLineItems {
          lineItem { id }
          quantity
          subtotalSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
        }
        suggestedTransactions {
          gateway
          formattedGateway
          amountSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

// Best-effort restock leg — needs `read_inventory` + `read_locations` on top of
// `read_orders`. Fetched separately so a store that hasn't granted inventory
// access still gets the full refund modal (just without restock locations).
const ORDER_RESTOCK_CONTEXT_QUERY = `
  query OrderRestockContext($id: ID!) {
    order(id: $id) {
      suggestedRefund(suggestFullRefund: true) {
        refundLineItems {
          lineItem { id }
          restockType
          location { id name }
        }
      }
    }
    locations(first: 20) {
      nodes { id name }
    }
  }
`;

type GqlMoneyBag = { readonly shopMoney: GqlMoney };

type GqlRefundContextResponse = {
  readonly order: {
    readonly id: string;
    readonly name: string;
    readonly currencyCode: string;
    readonly lineItems: {
      readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly sku: string | null;
        readonly variantTitle: string | null;
        readonly quantity: number;
        readonly refundableQuantity: number;
        readonly unfulfilledQuantity: number;
        readonly restockable: boolean;
        readonly discountedUnitPriceSet: GqlMoneyBag;
        readonly image: { readonly url: string } | null;
      }>;
    };
    readonly suggestedRefund: {
      readonly subtotalSet: GqlMoneyBag;
      readonly maximumRefundableSet: GqlMoneyBag;
      readonly shipping: {
        readonly amountSet: GqlMoneyBag;
        readonly maximumRefundableSet: GqlMoneyBag;
      };
      readonly refundLineItems: ReadonlyArray<{
        readonly lineItem: { readonly id: string };
        readonly quantity: number;
        readonly subtotalSet: GqlMoneyBag;
        readonly totalTaxSet: GqlMoneyBag;
      }>;
      readonly suggestedTransactions: ReadonlyArray<{
        readonly gateway: string | null;
        readonly formattedGateway: string | null;
        readonly amountSet: GqlMoneyBag;
      }>;
    } | null;
  } | null;
};

type GqlRestockContextResponse = {
  readonly order: {
    readonly suggestedRefund: {
      readonly refundLineItems: ReadonlyArray<{
        readonly lineItem: { readonly id: string };
        readonly restockType: string;
        readonly location: { readonly id: string; readonly name: string } | null;
      }>;
    } | null;
  } | null;
  readonly locations: {
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  };
};

// Per-unit money from a line's total + quantity. Rounds to 2dp for display /
// client-side partial-selection math; the default refund amount uses Shopify's
// exact `maximumRefundable`, and Shopify re-validates the issued amount, so this
// rounding never decides what actually moves.
const perUnitMoney = (
  total: GqlMoney,
  quantity: number,
): ShopifyMoney => ({
  amount:
    quantity > 0
      ? (Number.parseFloat(total.amount) / quantity).toFixed(2)
      : total.amount,
  currencyCode: total.currencyCode,
});

const DISCOUNT_CODE_CREATE_MUTATION = `
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            startsAt
            endsAt
            usageLimit
            appliesOncePerCustomer
            codes(first: 1) { nodes { code } }
            customerGets {
              value {
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount currencyCode } }
              }
            }
          }
        }
      }
      userErrors { field code message }
    }
  }
`;

type GqlDiscountCodeNode = {
  readonly id: string;
  readonly codeDiscount: {
    readonly title: string;
    readonly startsAt: string;
    readonly endsAt: string | null;
    readonly usageLimit: number | null;
    readonly appliesOncePerCustomer: boolean;
    readonly codes: { readonly nodes: ReadonlyArray<{ readonly code: string }> };
    readonly customerGets: {
      readonly value:
        | { readonly percentage: number }
        | { readonly amount: GqlMoney }
        | Record<string, never>;
    };
  };
};

type DiscountCreatePayload = {
  readonly discountCodeBasicCreate: {
    readonly codeDiscountNode: GqlDiscountCodeNode | null;
    readonly userErrors: ReadonlyArray<{
      readonly field: ReadonlyArray<string> | null;
      readonly message: string;
      readonly code: string | null;
    }>;
  };
};

// Pick the transaction we'll refund against. Shopify refunds attach
// to a parent SALE/CAPTURE that's in SUCCESS state. We pick the first
// one and call it good — multi-transaction refund splits (e.g. gift
// card + credit card on the same order) are a v2 concern.
/**
 * Derive a deterministic RFC-4122 v5-shaped UUID from an arbitrary seed
 * string. Shopify's `@idempotent` directive wants a UUID; callers hand us
 * varied keys (`dash-refund:<ticket>:<order>:<amount>:<currency>`, a tool
 * `callId`), so we hash the seed into a stable UUID. Deterministic on purpose:
 * retrying the exact same refund yields the same key, so Shopify returns the
 * original result instead of issuing a second refund. Changing any parameter
 * (e.g. the amount) changes the seed → a fresh key → a genuinely new refund.
 */
export const toIdempotencyUuid = (seed: string): string => {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  const b = Buffer.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const pickParentTransaction = (
  txs: ReadonlyArray<GqlTransaction>,
): GqlTransaction | null => {
  for (const t of txs) {
    if (
      (t.kind === "SALE" || t.kind === "CAPTURE") &&
      t.status === "SUCCESS" &&
      t.gateway
    ) {
      return t;
    }
  }
  return null;
};

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

      getProduct: (tenantId, productId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{ product: GqlProduct | null }>(
            http,
            creds,
            tenantId,
            GET_PRODUCT_QUERY,
            { id: productGid(productId) },
          ).pipe(
            Effect.flatMap((data) =>
              data.product
                ? Effect.succeed(mapProduct(data.product))
                : Effect.fail(new ProductNotFound({ productId })),
            ),
          ),
        ),

      searchProducts: (tenantId, query, limit) =>
        withCreds(tenantId, (creds) =>
          runQuery<{ products: { nodes: ReadonlyArray<GqlProductSearchNode> } }>(
            http,
            creds,
            tenantId,
            SEARCH_PRODUCTS_QUERY,
            // Clamp to a sane window: Shopify's `first` must be 1..250, and
            // we never want a giant page. The tool passes a small limit;
            // this is defence-in-depth against a bad caller.
            { q: query, n: Math.min(Math.max(limit, 1), 50) },
          ).pipe(
            Effect.map((data) =>
              data.products.nodes
                // Admin search sees DRAFT/ARCHIVED products; a customer
                // never does. Filter post-fetch (may under-fill the page —
                // fine for a "do you sell X?" answer) rather than splicing
                // `status:active` into the merchant-facing query string.
                .filter((p) => p.status === "ACTIVE")
                .map(mapProductSearchNode),
            ),
          ),
        ),

      getShopInfo: (tenantId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            shop: {
              name: string;
              contactEmail: string | null;
              currencyCode: string;
              primaryDomain: { url: string };
              shipsToCountries: ReadonlyArray<string>;
            };
          }>(http, creds, tenantId, SHOP_INFO_QUERY, {}).pipe(
            Effect.map((data) => {
              const contact = data.shop.contactEmail?.trim() ?? "";
              return {
                name: data.shop.name,
                // Blank-string contact collapses to null so callers have
                // one "no public contact" shape to handle.
                contactEmail: contact.length > 0 ? contact : null,
                currencyCode: data.shop.currencyCode,
                primaryDomainUrl: data.shop.primaryDomain.url,
                shipsToCountries: [...data.shop.shipsToCountries],
              };
            }),
          ),
        ),

      getShopPolicies: (tenantId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            shop: { shopPolicies: ReadonlyArray<ShopPolicy> };
          }>(http, creds, tenantId, SHOP_POLICIES_QUERY, {}).pipe(
            Effect.map((data) =>
              data.shop.shopPolicies.map(
                (p): ShopPolicy => ({
                  type: p.type,
                  title: p.title,
                  body: p.body,
                  url: p.url,
                }),
              ),
            ),
          ),
        ),

      listPickupLocations: (tenantId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            locations: {
              nodes: ReadonlyArray<{
                name: string;
                localPickupSettingsV2: { instructions: string | null } | null;
                address: {
                  address1: string | null;
                  address2: string | null;
                  city: string | null;
                  province: string | null;
                  country: string | null;
                  zip: string | null;
                  phone: string | null;
                } | null;
              }>;
            };
          }>(http, creds, tenantId, PICKUP_LOCATIONS_QUERY, {}).pipe(
            Effect.map((data) =>
              data.locations.nodes
                .filter((l) => l.localPickupSettingsV2 !== null)
                .map((l) => {
                  const instructions =
                    l.localPickupSettingsV2?.instructions?.trim() ?? "";
                  return {
                    name: l.name,
                    instructions:
                      instructions.length > 0 ? instructions : null,
                    address1: l.address?.address1 ?? null,
                    address2: l.address?.address2 ?? null,
                    city: l.address?.city ?? null,
                    province: l.address?.province ?? null,
                    country: l.address?.country ?? null,
                    zip: l.address?.zip ?? null,
                    phone: l.address?.phone ?? null,
                  };
                }),
            ),
          ),
        ),

      getOnlineStorePages: (tenantId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            pages: {
              nodes: ReadonlyArray<{
                title: string;
                handle: string;
                body: string;
                isPublished: boolean;
              }>;
            };
          }>(http, creds, tenantId, ONLINE_STORE_PAGES_QUERY, { n: 50 }).pipe(
            Effect.map((data) =>
              data.pages.nodes.map((p) => ({
                title: p.title,
                handle: p.handle,
                body: p.body,
                isPublished: p.isPublished,
              })),
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

      searchByPhone: (tenantId, phone) =>
        withCreds(tenantId, (creds) => {
          // Strip formatting a merchant might paste (spaces, dashes, parens)
          // so the `phone:` filter sees just the digits/`+`. Shopify stores
          // E.164, so an exact match still isn't guaranteed — best-effort.
          const normalized = phone.replace(/[^\d+]/g, "");
          if (normalized.length === 0) return Effect.succeed(null);
          return runQuery<{ customers: { nodes: ReadonlyArray<GqlCustomer> } }>(
            http,
            creds,
            tenantId,
            SEARCH_CUSTOMER_QUERY,
            { q: `phone:${normalized}` },
          ).pipe(
            Effect.map((data) => {
              const first = data.customers.nodes[0];
              return first ? mapCustomer(first) : null;
            }),
          );
        }),

      searchByName: (tenantId, name) =>
        withCreds(tenantId, (creds) => {
          // Free-text name search — Shopify matches it against the customer's
          // first/last name. Fuzzy by design (last-resort fallback); returns
          // the first hit. Quote the term so a multi-word name is one phrase.
          const trimmed = name.trim();
          if (trimmed.length === 0) return Effect.succeed(null);
          return runQuery<{ customers: { nodes: ReadonlyArray<GqlCustomer> } }>(
            http,
            creds,
            tenantId,
            SEARCH_CUSTOMER_QUERY,
            { q: `"${trimmed.replace(/"/g, "")}"` },
          ).pipe(
            Effect.map((data) => {
              const first = data.customers.nodes[0];
              return first ? mapCustomer(first) : null;
            }),
          );
        }),

      findOrderByName: (tenantId, name) =>
        withCreds(tenantId, (creds) => {
          // Shopify's `orders` query expects names with the leading `#`.
          // Customers sometimes type it with the `#`, sometimes without —
          // normalize so the agent never has to think about it.
          const normalized = name.startsWith("#") ? name : `#${name}`;
          return runQuery<{ orders: { nodes: ReadonlyArray<GqlOrder> } }>(
            http,
            creds,
            tenantId,
            SEARCH_ORDER_BY_NAME_QUERY,
            { q: `name:${normalized}` },
          ).pipe(
            Effect.map((data) => {
              const first = data.orders.nodes[0];
              return first ? mapOrder(first) : null;
            }),
          );
        }),

      findOrderByConfirmationNumber: (tenantId, confirmationNumber) =>
        withCreds(tenantId, (creds) => {
          // Confirmation numbers are alphanumeric (e.g. "XPAV284CT"). Strip
          // anything else so a stray "#", space, or search operator pasted
          // from a customer message can't malform the `confirmation_number:`
          // filter. An empty code after stripping is a guaranteed miss —
          // short-circuit to null without spending a Shopify call.
          const code = confirmationNumber.replace(/[^A-Za-z0-9]/g, "");
          if (code.length === 0) return Effect.succeed(null);
          return runQuery<{ orders: { nodes: ReadonlyArray<GqlOrder> } }>(
            http,
            creds,
            tenantId,
            SEARCH_ORDER_BY_CONFIRMATION_QUERY,
            { q: `confirmation_number:${code}` },
          ).pipe(
            Effect.map((data) => {
              const first = data.orders.nodes[0];
              return first ? mapOrder(first) : null;
            }),
          );
        }),

      findOrdersByEmail: (tenantId, email, limit) =>
        withCreds(tenantId, (creds) => {
          const normalized = email.trim();
          if (normalized.length === 0) return Effect.succeed([]);
          // Cap defensively: the caller only needs to distinguish one
          // order from many, and a single GraphQL page is plenty.
          const n = Math.max(1, Math.min(limit, 50));
          return runQuery<{ orders: { nodes: ReadonlyArray<GqlOrder> } }>(
            http,
            creds,
            tenantId,
            LIST_ORDERS_BY_EMAIL_QUERY,
            { q: `email:${normalized}`, n },
          ).pipe(Effect.map((data) => data.orders.nodes.map(mapOrder)));
        }),

      findOrdersByCustomerId: (tenantId, customerId, limit) =>
        withCreds(tenantId, (creds) => {
          const n = Math.max(1, Math.min(limit, 50));
          return runQuery<{
            customer: { orders: { nodes: ReadonlyArray<GqlOrder> } } | null;
          }>(http, creds, tenantId, LIST_ORDERS_BY_CUSTOMER_QUERY, {
            id: customerGid(customerId),
            n,
          }).pipe(
            Effect.map((data) =>
              data.customer ? data.customer.orders.nodes.map(mapOrder) : [],
            ),
          );
        }),

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

      getOrderRefundContext: (tenantId, orderId) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            const orderGidStr = orderGid(orderId);
            // Core leg (read_orders only): line items + Shopify's own
            // suggestedRefund calculation.
            const data = yield* runQuery<GqlRefundContextResponse>(
              http,
              creds,
              tenantId,
              ORDER_REFUND_CONTEXT_QUERY,
              { id: orderGidStr },
            );
            const order = data.order;
            if (!order || !order.suggestedRefund) {
              return yield* Effect.fail(new OrderNotFound({ orderId }));
            }
            const suggested = order.suggestedRefund;

            // Best-effort restock leg (needs read_inventory). On any failure —
            // most commonly a store that hasn't granted inventory access — fall
            // back to no restock locations rather than failing the whole modal.
            const restock = yield* runQuery<GqlRestockContextResponse>(
              http,
              creds,
              tenantId,
              ORDER_RESTOCK_CONTEXT_QUERY,
              { id: orderGidStr },
            ).pipe(Effect.catchAll(() => Effect.succeed(null)));

            const suggestedByLine = new Map(
              suggested.refundLineItems.map((r) => [r.lineItem.id, r]),
            );
            const restockByLine = new Map(
              (restock?.order?.suggestedRefund?.refundLineItems ?? []).map(
                (r) => [r.lineItem.id, r],
              ),
            );
            const locations: ReadonlyArray<ShopifyLocation> = (
              restock?.locations?.nodes ?? []
            ).map((l) => ({ id: l.id, name: l.name }));

            const lineItems: ReadonlyArray<ShopifyRefundLineItem> = order.lineItems.nodes
              .filter((n) => n.refundableQuantity > 0)
              .map((n) => {
                const s = suggestedByLine.get(n.id);
                const r = restockByLine.get(n.id);
                const unitPrice = s
                  ? perUnitMoney(s.subtotalSet.shopMoney, s.quantity)
                  : mapMoney(n.discountedUnitPriceSet.shopMoney);
                const unitTax = s
                  ? perUnitMoney(s.totalTaxSet.shopMoney, s.quantity)
                  : { amount: "0.00", currencyCode: order.currencyCode };
                return {
                  lineItemId: n.id,
                  title: n.title,
                  variantTitle: n.variantTitle,
                  sku: n.sku,
                  imageUrl: n.image?.url ?? null,
                  refundableQuantity: n.refundableQuantity,
                  unitPrice,
                  unitTax,
                  restockable: n.restockable,
                  fulfilled: n.unfulfilledQuantity === 0,
                  restockLocationId: r?.location?.id ?? null,
                };
              });

            const tx = suggested.suggestedTransactions[0];
            const result: ShopifyOrderRefundContext = {
              orderId,
              orderName: order.name,
              currencyCode: order.currencyCode,
              subtotal: mapMoney(suggested.subtotalSet.shopMoney),
              maximumRefundable: mapMoney(
                suggested.maximumRefundableSet.shopMoney,
              ),
              shippingRefundable: mapMoney(
                suggested.shipping.maximumRefundableSet.shopMoney,
              ),
              paymentGateway:
                tx?.formattedGateway ?? tx?.gateway ?? null,
              lineItems,
              locations,
            };
            return result;
          }),
        ),

      refundOrder: (tenantId, input: RefundOrderInput) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            // Step 1: fetch transactions so we can pick a parent to
            // refund against. Shopify requires `transactions[]` with
            // `kind: REFUND`, `parentId`, and `gateway` to be present
            // for the money to actually move. Without these the refund
            // is just a recorded ledger entry — not what merchants want
            // when they say "refund this order".
            const orderGidStr = orderGid(input.orderId);
            const txData = yield* runQuery<{
              order: {
                readonly currencyCode: string;
                readonly transactions: ReadonlyArray<GqlTransaction>;
              } | null;
            }>(http, creds, tenantId, GET_ORDER_TRANSACTIONS_QUERY, {
              id: orderGidStr,
            });

            if (!txData.order) {
              return yield* Effect.fail(
                new OrderNotFound({ orderId: input.orderId }),
              );
            }

            // Defensive: refunds in a different currency than the order
            // would silently get reinterpreted by Shopify. Fail loudly
            // so the operator notices the mismatch before money moves.
            if (
              txData.order.currencyCode.toUpperCase() !==
              input.amount.currencyCode.toUpperCase()
            ) {
              return yield* Effect.fail(
                new RefundFailed({
                  orderId: input.orderId,
                  code: "CURRENCY_MISMATCH",
                  message: `Order is in ${txData.order.currencyCode}, refund requested in ${input.amount.currencyCode}`,
                }),
              );
            }

            const parent = pickParentTransaction(txData.order.transactions);
            if (!parent) {
              return yield* Effect.fail(
                new RefundFailed({
                  orderId: input.orderId,
                  code: "NO_REFUNDABLE_TRANSACTION",
                  message:
                    "No refundable SALE/CAPTURE transaction found on the order",
                }),
              );
            }

            // Step 2: build the RefundInput. `transactions[].parentId`
            // points at the original sale; `kind: "REFUND"` flips it
            // from a charge to a refund; `gateway` must match the parent
            // (Shopify rejects mismatched gateways).
            // The dashboard refund modal additionally selects which line
            // items to restock (and the shipping to refund); the agent's
            // amount-only `refund.create` path leaves both unset. Shopify
            // requires a `locationId` for RETURN/CANCEL restocks and rejects
            // it for NO_RESTOCK, so we only attach it when restocking.
            const refundLineItems = (input.lineItems ?? [])
              .filter((li) => li.quantity > 0)
              .map((li) => ({
                lineItemId: li.lineItemId,
                quantity: li.quantity,
                restockType: li.restockType,
                ...(li.restockType !== "NO_RESTOCK" && li.locationId
                  ? { locationId: li.locationId }
                  : {}),
              }));

            const refundInput = {
              orderId: orderGidStr,
              note: input.note,
              notify: input.notifyCustomer,
              ...(refundLineItems.length > 0 ? { refundLineItems } : {}),
              ...(input.shipping
                ? { shipping: { amount: input.shipping.amount } }
                : {}),
              transactions: [
                {
                  orderId: orderGidStr,
                  parentId: parent.id,
                  amount: input.amount.amount,
                  gateway: parent.gateway,
                  kind: "REFUND",
                },
              ],
            };

            // Mandatory @idempotent key (2026-04). Seed from the caller's key
            // when present; else a stable fingerprint of the refund so a naive
            // retry still dedupes rather than double-refunding.
            const idempotencyKey = toIdempotencyUuid(
              input.idempotencyKey ??
                `${orderGidStr}:${input.amount.amount}:${input.amount.currencyCode}`,
            );
            const refundData = yield* runQuery<RefundCreatePayload>(
              http,
              creds,
              tenantId,
              REFUND_CREATE_MUTATION,
              { input: refundInput, idempotencyKey },
            );

            // Step 3: map the result. `userErrors` is Shopify's
            // structured rejection channel — if present we map to
            // RefundFailed regardless of HTTP status. A null `refund`
            // with empty userErrors is a defensive ticket (shouldn't
            // happen but covers the schema): treat as a refundFailed
            // with a generic message.
            const payload = refundData.refundCreate;
            const firstError = payload.userErrors[0];
            if (firstError) {
              return yield* Effect.fail(
                new RefundFailed({
                  orderId: input.orderId,
                  // `refundCreate.userErrors` (base UserError) carries no
                  // machine-readable code — only field + message.
                  code: null,
                  message: firstError.message,
                }),
              );
            }
            if (!payload.refund) {
              return yield* Effect.fail(
                new RefundFailed({
                  orderId: input.orderId,
                  code: null,
                  message: "refundCreate returned no refund and no userErrors",
                }),
              );
            }
            const refund = payload.refund;
            const result: ShopifyRefund = {
              id: refund.id,
              orderId: input.orderId,
              amount: mapMoney(refund.totalRefundedSet.shopMoney),
              note: refund.note,
              createdAt: new Date(refund.createdAt),
            };
            return result;
          }),
        ),

      cancelOrder: (tenantId, input: CancelOrderInput) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            const data = yield* runQuery<OrderCancelPayload>(
              http,
              creds,
              tenantId,
              ORDER_CANCEL_MUTATION,
              {
                orderId: orderGid(input.orderId),
                // Domain reason ("customer") → Shopify's OrderCancelReason
                // enum (CUSTOMER). The tool only ever passes "customer", but
                // the union is mapped generically so a future caller can pass
                // FRAUD / INVENTORY / etc.
                reason: input.reason.toUpperCase(),
                refund: input.refund,
                restock: input.restock,
                notifyCustomer: input.notifyCustomer,
                staffNote: input.staffNote,
              },
            );

            const payload = data.orderCancel;
            const firstError = payload.orderCancelUserErrors[0];
            if (firstError) {
              return yield* Effect.fail(
                new OrderCancelFailed({
                  orderId: input.orderId,
                  code: firstError.code ?? null,
                  message: firstError.message,
                }),
              );
            }
            const result: ShopifyOrderCancellation = {
              orderId: input.orderId,
              jobId: payload.job?.id ?? null,
              accepted: true,
            };
            return result;
          }),
        ),

      updateOrderShippingAddress: (tenantId, input) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            const orderGidStr = orderGid(input.orderId);
            const a = input.address;
            const data = yield* runQuery<OrderUpdatePayload>(
              http,
              creds,
              tenantId,
              ORDER_UPDATE_SHIPPING_ADDRESS_MUTATION,
              {
                input: {
                  id: orderGidStr,
                  shippingAddress: {
                    ...splitAddressName(a.name),
                    ...(a.address1 !== null ? { address1: a.address1 } : {}),
                    ...(a.address2 !== null ? { address2: a.address2 } : {}),
                    ...(a.city !== null ? { city: a.city } : {}),
                    ...(a.province !== null ? { province: a.province } : {}),
                    ...(a.country !== null ? { country: a.country } : {}),
                    ...(a.zip !== null ? { zip: a.zip } : {}),
                    ...(a.phone !== null ? { phone: a.phone } : {}),
                  },
                },
              },
            );

            const payload = data.orderUpdate;
            const firstError = payload.userErrors[0];
            if (firstError) {
              return yield* Effect.fail(
                new OrderUpdateFailed({
                  orderId: input.orderId,
                  // Base `UserError` carries no code; see the mutation note.
                  code: null,
                  message: firstError.message,
                }),
              );
            }
            const stored = mapAddress(payload.order?.shippingAddress ?? null);
            if (!stored) {
              return yield* Effect.fail(
                new OrderUpdateFailed({
                  orderId: input.orderId,
                  code: null,
                  message:
                    "orderUpdate returned no shipping address and no userErrors",
                }),
              );
            }
            return stored;
          }),
        ),

      updateFulfillmentTracking: (tenantId, input) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            const data = yield* runQuery<FulfillmentTrackingUpdatePayload>(
              http,
              creds,
              tenantId,
              FULFILLMENT_TRACKING_UPDATE_MUTATION,
              {
                fulfillmentId: input.fulfillmentId,
                trackingInfoInput: {
                  number: input.trackingNumber,
                  ...(input.trackingCompany !== null
                    ? { company: input.trackingCompany }
                    : {}),
                },
                notifyCustomer: input.notifyCustomer,
              },
            );

            const payload = data.fulfillmentTrackingInfoUpdate;
            const firstError = payload.userErrors[0];
            if (firstError) {
              return yield* Effect.fail(
                new FulfillmentUpdateFailed({
                  fulfillmentId: input.fulfillmentId,
                  // Base `UserError` carries no code; see the mutation note.
                  code: null,
                  message: firstError.message,
                }),
              );
            }
            if (!payload.fulfillment) {
              return yield* Effect.fail(
                new FulfillmentUpdateFailed({
                  fulfillmentId: input.fulfillmentId,
                  code: null,
                  message:
                    "fulfillmentTrackingInfoUpdate returned no fulfillment and no userErrors",
                }),
              );
            }
            return mapFulfillment(payload.fulfillment);
          }),
        ),

      createDiscountCode: (tenantId, input) =>
        withCreds(tenantId, (creds) =>
          Effect.gen(function* () {
            // Shopify's `DiscountPercentage.percentage` is a FRACTION in
            // 0..1 (0.10 ⇒ 10%), not 0..100 — convert from our domain's
            // whole-percent string. Fixed amounts pass through as a decimal
            // string in the order currency.
            const value =
              input.valueType === "percentage"
                ? { percentage: Number.parseFloat(input.value) / 100 }
                : {
                    discountAmount: {
                      amount: input.value,
                      appliesOnEachItem: false,
                    },
                  };

            // Guardrails baked in here so the Admin API can never receive a
            // combinable / multi-use / store-wide-eligible coupon even if a
            // caller forgets: single customer, non-combinable, entire-order.
            // `usageLimit` / `appliesOncePerCustomer` / `endsAt` come from
            // the caller (the tool resolves them from policy).
            const basicCodeDiscount = {
              title: input.title,
              code: input.code,
              startsAt: new Date().toISOString(),
              endsAt: input.endsAt.toISOString(),
              usageLimit: input.usageLimit,
              appliesOncePerCustomer: input.appliesOncePerCustomer,
              customerSelection: {
                customers: { add: [customerGid(input.customerId)] },
              },
              customerGets: { value, items: { all: true } },
              combinesWith: {
                orderDiscounts: false,
                productDiscounts: false,
                shippingDiscounts: false,
              },
            };

            const data = yield* runQuery<DiscountCreatePayload>(
              http,
              creds,
              tenantId,
              DISCOUNT_CODE_CREATE_MUTATION,
              { basicCodeDiscount },
            );

            const payload = data.discountCodeBasicCreate;
            const firstError = payload.userErrors[0];
            if (firstError) {
              return yield* Effect.fail(
                new DiscountFailed({
                  code: firstError.code ?? null,
                  message: firstError.message,
                }),
              );
            }
            const node = payload.codeDiscountNode;
            if (!node) {
              return yield* Effect.fail(
                new DiscountFailed({
                  code: null,
                  message:
                    "discountCodeBasicCreate returned no node and no userErrors",
                }),
              );
            }
            const cd = node.codeDiscount;
            // The canonical value/type/currency are the INPUT (what we asked
            // for) — we deliberately don't round-trip through Shopify's
            // percentage float (0.15 * 100 drifts). Shopify's echo only
            // confirms the code string + endsAt landed.
            const result: ShopifyDiscount = {
              id: node.id,
              code: cd.codes.nodes[0]?.code ?? input.code,
              title: cd.title,
              valueType: input.valueType,
              value: input.value,
              currencyCode: input.currencyCode,
              customerId: input.customerId,
              usageLimit: cd.usageLimit ?? input.usageLimit,
              endsAt: cd.endsAt ? new Date(cd.endsAt) : input.endsAt,
              createdAt: new Date(),
            };
            return result;
          }),
        ),

      listRecentOrderPiiPresence: (tenantId, limit) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            orders: {
              nodes: ReadonlyArray<{
                name: string;
                email: string | null;
                shippingAddress: {
                  name: string | null;
                  address1: string | null;
                  city: string | null;
                } | null;
              }>;
            };
          }>(http, creds, tenantId, RECENT_ORDERS_PII_QUERY, {
            // Clamp to a sane window: enough orders to rule out a single
            // genuinely-PII-less order skewing the verdict, capped so the
            // probe stays one cheap request.
            n: Math.max(1, Math.min(limit, 25)),
          }).pipe(
            Effect.map((data) =>
              data.orders.nodes.map((o): OrderPiiPresence => {
                const nonEmpty = (s: string | null | undefined): boolean =>
                  typeof s === "string" && s.trim().length > 0;
                return {
                  orderName: o.name,
                  hasEmail: nonEmpty(o.email),
                  hasCustomerName: nonEmpty(o.shippingAddress?.name),
                  hasShippingAddress:
                    nonEmpty(o.shippingAddress?.address1) ||
                    nonEmpty(o.shippingAddress?.city),
                };
              }),
            ),
          ),
        ),

      getCustomerRefundHistory: (tenantId, customerId) =>
        withCreds(tenantId, (creds) =>
          runQuery<{
            customer: {
              ordersCount?: { count?: number };
              orders: {
                edges: ReadonlyArray<{
                  node: {
                    id: string;
                    createdAt: string;
                    refunds: ReadonlyArray<{
                      id: string;
                      totalRefundedSet?: {
                        shopMoney: { amount: string; currencyCode: string };
                      };
                    }>;
                  };
                }>;
              };
            } | null;
          }>(http, creds, tenantId, GET_CUSTOMER_REFUND_HISTORY_QUERY, {
            id: customerGid(customerId),
          }).pipe(
            Effect.flatMap((data) => {
              if (!data.customer) {
                return Effect.fail(new CustomerNotFound({ query: customerId }));
              }
              const edges = data.customer.orders.edges;
              // Walk all orders once: count refunded orders, sum refund
              // amounts, and find the earliest createdAt. The currency
              // is taken from the FIRST refund we see — never invented.
              // Customers whose refunds span multiple currencies are
              // rare in practice; the flag math only needs a single
              // representative currency to compare against the policy.
              let refundedOrdersCount = 0;
              let firstOrderAtMs = Number.POSITIVE_INFINITY;
              let sumCents = 0;
              let refundCurrency: string | null = null;
              for (const { node } of edges) {
                const created = new Date(node.createdAt).getTime();
                if (Number.isFinite(created) && created < firstOrderAtMs) {
                  firstOrderAtMs = created;
                }
                if (node.refunds.length > 0) {
                  refundedOrdersCount += 1;
                  for (const r of node.refunds) {
                    const money = r.totalRefundedSet?.shopMoney;
                    if (!money) continue;
                    const amount = Number.parseFloat(money.amount);
                    if (Number.isFinite(amount)) {
                      sumCents += Math.round(amount * 100);
                    }
                    if (refundCurrency === null) {
                      refundCurrency = money.currencyCode;
                    }
                  }
                }
              }
              const result: CustomerRefundHistory = {
                // Prefer the API-reported total when available — it
                // covers orders beyond the first 50; otherwise fall
                // back to the edge count.
                ordersCount:
                  data.customer.ordersCount?.count ?? edges.length,
                refundedOrdersCount,
                totalRefundedAmount:
                  refundCurrency !== null
                    ? {
                        amount: (sumCents / 100).toFixed(2),
                        currencyCode: refundCurrency,
                      }
                    : null,
                firstOrderAt:
                  firstOrderAtMs === Number.POSITIVE_INFINITY
                    ? null
                    : new Date(firstOrderAtMs),
              };
              return Effect.succeed(result);
            }),
          ),
        ),
    });
  }),
);
