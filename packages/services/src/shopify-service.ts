import { Context, Effect, Layer } from "effect";
import {
  type CustomerId,
  type OrderId,
  type ShopifyCustomer,
  type ShopifyError,
  type ShopifyFulfillment,
  type ShopifyMoney,
  type ShopifyOrder,
  type ShopifyProduct,
  type ShopifyProductSearchResult,
  type ShopifyRefund,
  type TenantId,
  CustomerNotFound,
  OrderNotFound,
  ProductNotFound,
  RefundFailed,
  ShopifyAuthMissing,
} from "@support-agent/agent-core";

/**
 * Input for `ShopifyService.refundOrder`. We deliberately keep the
 * shape narrow for v1: amount-only refunds against the order's primary
 * refundable transaction. Line-item refunds (where you specify which
 * SKUs/quantities to return) are a follow-up — they need quantity
 * math, restocking decisions, and shipping refund logic that aren't
 * worth coupling into this MVP. `idempotencyKey` lets the runtime
 * dedupe retries; the Live impl threads it into the mutation's
 * `clientMutationId`-style header pattern.
 */
export interface RefundOrderInput {
  readonly orderId: OrderId;
  readonly amount: ShopifyMoney;
  readonly note: string | null;
  readonly notifyCustomer: boolean;
  readonly idempotencyKey: string | null;
}

/**
 * The provider-agnostic interface for Shopify queries. Every method
 * takes a `TenantId` so the Live impl can resolve per-tenant credentials
 * through `ShopifyCredentialStore`. Tools call into this Tag — never the
 * Live impl or `fetch` directly — so the same tool code runs in tests
 * against a Test layer and in prod against the GraphQL Admin API.
 */
export class ShopifyService extends Context.Tag("ShopifyService")<
  ShopifyService,
  {
    readonly getOrder: (
      tenantId: TenantId,
      orderId: OrderId,
    ) => Effect.Effect<ShopifyOrder, ShopifyError>;

    readonly getCustomer: (
      tenantId: TenantId,
      customerId: CustomerId,
    ) => Effect.Effect<ShopifyCustomer, ShopifyError>;

    /**
     * Look up a product by its GID (`gid://shopify/Product/...`) or bare
     * numeric id. Returns the product's title, type, vendor, and
     * reference images. Used by `shopify.get_product` so a specialist
     * (the damaged-product agent) can compare the depicted item against
     * customer-supplied damage photos. `ProductNotFound` when the id is
     * unknown. Needs the `read_products` Shopify scope.
     */
    readonly getProduct: (
      tenantId: TenantId,
      productId: string,
    ) => Effect.Effect<ShopifyProduct, ShopifyError>;

    /**
     * Keyword search over the store's product catalog. Backs
     * `shopify.search_products` so the general-inquiry agent can answer
     * "do you sell X?" / basic product-attribute questions grounded in
     * the real catalog. `query` is free text (Shopify's product `query:`
     * syntax — matches title/type/vendor/tag); `limit` caps the result
     * count. Returns an empty array on no match — a search miss isn't an
     * error, unlike `getProduct`'s `ProductNotFound`. Needs the
     * `read_products` Shopify scope.
     */
    readonly searchProducts: (
      tenantId: TenantId,
      query: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ShopifyProductSearchResult>, ShopifyError>;

    /**
     * Read the connected store's public facts: name, customer-facing
     * contact email, primary domain, default currency, and the countries
     * the store ships to. Backs `shopify.get_store_info` (general-inquiry
     * grounding) and the dashboard refund-policy page's "your policy
     * currency doesn't match your store" warning. `ShopifyAuthMissing`
     * when the tenant has no live Shopify connection; callers that only
     * want a best-effort hint catch it and fall back to "unknown".
     */
    readonly getShopInfo: (
      tenantId: TenantId,
    ) => Effect.Effect<ShopInfo, ShopifyError>;

    /**
     * Read the store's configured shop policies (refund, shipping, privacy,
     * …) as authored in the Shopify admin. Backs the post-connect knowledge
     * import that seeds the tenant knowledge base with the merchant's own
     * shipping + refund policy text, so specialists can ground answers in it.
     * Returns an empty array when the store has no policies configured — a
     * store with nothing set is the norm, not an error. Needs no extra scope
     * beyond the base read access the connect flow already grants.
     */
    readonly getShopPolicies: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<ShopPolicy>, ShopifyError>;

    /**
     * List the store's customer pickup locations — ONLY active locations
     * with local pickup enabled. The filter is deliberately part of the
     * service contract, not the caller's job: Shopify's raw `locations`
     * include private warehouses, 3PLs, and dropship origins, and no
     * caller of this service may ever see those. Returns an empty array
     * when the store offers no pickup. Needs the `read_locations` scope.
     */
    readonly listPickupLocations: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<PickupLocation>, ShopifyError>;

    /**
     * Read the store's Online Store pages (About, Contact, FAQ, blog
     * landing pages, …) with their publication flag. Backs the
     * post-connect knowledge import's page leg — the importer applies a
     * conservative About/Contact/FAQ heuristic and publication filter on
     * top; this method reports pages as-is. Returns an empty array when
     * the store has none. Needs the `read_online_store_pages` scope, so
     * connections installed before that scope was requested fail here
     * with a Shopify auth error — callers treat it as best-effort.
     */
    readonly getOnlineStorePages: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<ShopPage>, ShopifyError>;

    readonly searchByEmail: (
      tenantId: TenantId,
      email: string,
    ) => Effect.Effect<ShopifyCustomer | null, ShopifyError>;

    /**
     * Look up an order by its merchant-facing name (e.g. "#1001" or
     * "1001"). Returns null when no match exists — Shopify's `orders`
     * query is a search, not a lookup, so a miss isn't an error. Use this
     * when the agent extracted an order number from a customer message;
     * use `getOrder` only when you already have a GID or internal id.
     */
    readonly findOrderByName: (
      tenantId: TenantId,
      name: string,
    ) => Effect.Effect<ShopifyOrder | null, ShopifyError>;

    /**
     * Look up an order by its customer-facing confirmation number (e.g.
     * "XPAV284CT") — the alphanumeric code Shopify prints on the order
     * confirmation page/email, which customers often quote instead of the
     * `#1001` order name. Backs the fallback leg of `shopify.get_order`:
     * when a name search misses, the tool retries here before giving up.
     * Returns null when no match exists (like `findOrderByName`, this is a
     * search, not a lookup — a miss isn't an error). Confirmation numbers
     * are NOT guaranteed unique, so a match is never proof of identity; the
     * order-email identity gate still gates disclosure.
     */
    readonly findOrderByConfirmationNumber: (
      tenantId: TenantId,
      confirmationNumber: string,
    ) => Effect.Effect<ShopifyOrder | null, ShopifyError>;

    /**
     * List a customer's orders by the email they placed them under, most
     * recent first. Backs `shopify.find_customer_order`, which a specialist
     * calls when the case carries no identified order id: if the customer
     * has exactly one order we infer that's the one they're writing about
     * (no need to ask for an order number); zero or many means we still
     * have to ask. Looking up BY the customer's own address is the
     * identity-safe path — every order returned belongs to that email.
     * `limit` caps the result (small — we only need to tell "one" from
     * "many"). Returns an empty array when the email matches no orders;
     * a miss isn't an error (like `findOrderByName`).
     */
    readonly findOrdersByEmail: (
      tenantId: TenantId,
      email: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ShopifyOrder>, ShopifyError>;

    readonly getFulfillment: (
      tenantId: TenantId,
      orderId: OrderId,
    ) => Effect.Effect<ReadonlyArray<ShopifyFulfillment>, ShopifyError>;

    /**
     * Issue a refund against an order. Money risk — every caller goes
     * through `PermissionService` first (the `refund.create` tool is
     * `defaultPermission: "ask"` and the runtime adds a conditional
     * threshold on top). Maps `refundCreate.userErrors` → `RefundFailed`;
     * structural failures (auth, network, rate limit) reuse the existing
     * `ShopifyError` tags so the tool boundary sees a consistent error
     * surface.
     */
    readonly refundOrder: (
      tenantId: TenantId,
      input: RefundOrderInput,
    ) => Effect.Effect<ShopifyRefund, ShopifyError>;

    /**
     * Aggregate refund history for a single customer. Used by
     * `refund.recommend` to compute risk flags (first_order /
     * frequent_refunder / new_customer / high_ltv).
     *
     * Reads the customer's recent orders (limit 50 — wide enough to
     * pick up power-users, narrow enough to stay a single GraphQL
     * request) and aggregates client-side:
     *   - `ordersCount`: total orders seen on the customer record.
     *   - `refundedOrdersCount`: how many of those carry at least one
     *     `refunds[]` entry.
     *   - `totalRefundedAmount`: sum across all refunds, currency taken
     *     from the first refund. Currency mismatch across orders is rare
     *     in practice; we report the first currency for the flag math.
     *   - `firstOrderAt`: minimum `createdAt` across the orders read.
     *
     * Returns zeros (and `firstOrderAt: null`) when the customer has
     * no orders. `CustomerNotFound` when the id is unknown.
     */
    readonly getCustomerRefundHistory: (
      tenantId: TenantId,
      customerId: CustomerId,
    ) => Effect.Effect<CustomerRefundHistory, ShopifyError>;

    /**
     * Probe whether the connected store actually returns protected
     * customer data, or hands it back redacted/null. Reads the most
     * recent `limit` orders and reports, per order, ONLY presence
     * booleans for the Level-2 PII fields — never the values themselves,
     * so no customer PII crosses this boundary (the operator PCD check
     * shouldn't itself leak PII into admin logs).
     *
     * Used by the admin "Run PCD check" tool: a custom-distribution app
     * that hasn't declared its protected customer data fields in the Dev
     * Dashboard gets those fields silently redacted on live stores, which
     * would quietly blank `getOrder`'s customer name/email/address. This
     * surfaces that misconfiguration before it breaks support flows.
     */
    readonly listRecentOrderPiiPresence: (
      tenantId: TenantId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<OrderPiiPresence>, ShopifyError>;
  }
>() {}

/**
 * Per-order presence flags for protected customer data. `orderName`
 * (e.g. "#1001") is not PII and is safe to surface; the three booleans
 * report whether each Level-2 field came back populated. The actual
 * field values are inspected and discarded inside the service so they
 * never reach the caller.
 */
export interface OrderPiiPresence {
  readonly orderName: string;
  readonly hasEmail: boolean;
  readonly hasCustomerName: boolean;
  readonly hasShippingAddress: boolean;
}

/**
 * Public store facts. Everything here is customer-facing by
 * construction: `name` and `primaryDomainUrl` are what the storefront
 * shows; `contactEmail` is the merchant's *customer-facing* contact
 * address (Shopify's `shop.contactEmail` — never `shop.email`, which is
 * the private account login); `shipsToCountries` is derived from the
 * store's shipping zones (ISO country codes) and answers "where do you
 * ship TO" — it says nothing about where orders ship *from*, which we
 * deliberately never expose. `currencyCode` is the shop's default
 * currency (ISO 4217); it also feeds the dashboard refund-policy
 * currency-mismatch warning.
 */
export interface ShopInfo {
  readonly name: string;
  readonly contactEmail: string | null;
  readonly primaryDomainUrl: string;
  readonly currencyCode: string;
  readonly shipsToCountries: ReadonlyArray<string>;
}

/**
 * One merchant-authored shop policy. `type` is the Shopify `ShopPolicyType`
 * enum value (e.g. `"REFUND_POLICY"`, `"SHIPPING_POLICY"`) — kept as a raw
 * string so a new policy type Shopify adds doesn't break this boundary;
 * callers match on the values they care about. `body` is the policy text as
 * HTML; `url` is the public storefront URL of the policy. Note Shopify has no
 * separate "return policy" — returns are covered by `REFUND_POLICY`.
 */
export interface ShopPolicy {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

/**
 * One customer pickup point: an active store location with local pickup
 * enabled. Existence in this type already implies "customers may come
 * here" — locations without pickup (warehouses, 3PLs) never reach this
 * shape. `instructions` is the merchant's pickup note ("ring the side
 * bell"), null when unset.
 */
export interface PickupLocation {
  readonly name: string;
  readonly instructions: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly zip: string | null;
  readonly phone: string | null;
}

/**
 * One Online Store page as authored in the Shopify admin. `body` is
 * HTML; `handle` is the URL slug (the public page lives at
 * `<primary domain>/pages/<handle>` when `isPublished` is true). Kept
 * raw at this boundary — selection and publication filtering are the
 * importer's policy decisions, not the service's.
 */
export interface ShopPage {
  readonly title: string;
  readonly handle: string;
  readonly body: string;
  readonly isPublished: boolean;
}

/**
 * Aggregated refund history for a single customer.
 *
 * `totalRefundedAmount` is `null` when the customer has no refunds —
 * we never invent a currency for them; on the Live path it's derived
 * from the actual refund records (so it matches the store's currency).
 * Callers that compute risk flags from a refund total must handle null
 * as "no refunds to consider".
 */
export interface CustomerRefundHistory {
  readonly ordersCount: number;
  readonly refundedOrdersCount: number;
  readonly totalRefundedAmount: ShopifyMoney | null;
  readonly firstOrderAt: Date | null;
}

// ============================================================
// Test layer — in-memory fixtures
// ============================================================

export interface ShopifyTestFixtures {
  readonly orders?: ReadonlyMap<OrderId, ShopifyOrder>;
  readonly customers?: ReadonlyMap<CustomerId, ShopifyCustomer>;
  readonly customersByEmail?: ReadonlyMap<string, ShopifyCustomer>;
  /**
   * Map from product id (GID or bare numeric, exactly as the caller
   * passes it) to ShopifyProduct. A miss fails with `ProductNotFound`,
   * matching the Live impl's null-data path.
   */
  readonly productsById?: ReadonlyMap<string, ShopifyProduct>;
  /**
   * Catalog-search fixture for `searchProducts`. A function of the query
   * (like `refundOrder`) so a test can return different matches per query
   * or assert the query was passed through. Defaults to "no matches".
   */
  readonly searchProducts?: (
    query: string,
  ) => ReadonlyArray<ShopifyProductSearchResult>;
  /**
   * Map from order *name* (with or without leading `#`) to ShopifyOrder.
   * Keys are normalized to `#XXXX` on lookup so tests can write either
   * `"#1001"` or `"1001"` in the fixture.
   */
  readonly ordersByName?: ReadonlyMap<string, ShopifyOrder>;
  /**
   * Map from order *confirmation number* (e.g. "XPAV284CT") to ShopifyOrder,
   * backing `findOrderByConfirmationNumber`. Keys are matched as written —
   * a test that wants to simulate a confirmation-number lookup seeds the
   * exact code the caller will pass.
   */
  readonly ordersByConfirmationNumber?: ReadonlyMap<string, ShopifyOrder>;
  /**
   * Map from a customer *email* to that customer's orders (most recent
   * first), backing `findOrdersByEmail`. Tests seed this to exercise the
   * single-order inference path (one order in the list) vs. the
   * ask-the-customer paths (zero or many). When the email isn't in the
   * map the default Test impl returns an empty list.
   */
  readonly ordersByEmail?: ReadonlyMap<string, ReadonlyArray<ShopifyOrder>>;
  readonly fulfillments?: ReadonlyMap<
    OrderId,
    ReadonlyArray<ShopifyFulfillment>
  >;
  /**
   * Optional override for `refundOrder`. When unset the default Test
   * impl synthesises a `ShopifyRefund` from the input — useful for
   * happy-path tests where the exact refund id doesn't matter. Tests
   * that need to assert the input shape or simulate failures override
   * this and inspect / throw from inside.
   */
  readonly refundOrder?: (
    input: RefundOrderInput,
  ) => Effect.Effect<ShopifyRefund, ShopifyError>;
  /**
   * Per-customer refund-history fixture. Tests that exercise
   * `refund.recommend` seed this with a known aggregate so the risk-flag
   * math is deterministic. When a customerId isn't in the map, the
   * default Test impl returns zeros (and `firstOrderAt: null`).
   */
  readonly customerRefundHistory?: ReadonlyMap<
    CustomerId,
    CustomerRefundHistory
  >;
  /**
   * Fixture for `listRecentOrderPiiPresence`. When unset the default Test
   * impl returns an empty list (the "no orders on the store yet" case).
   */
  readonly recentOrderPiiPresence?: ReadonlyArray<OrderPiiPresence>;
  /**
   * Fixture for `getShopInfo`. When unset the default Test impl fails with
   * `ShopifyAuthMissing` — the "no Shopify connection" case, which best-
   * effort callers treat as "store currency unknown".
   */
  readonly shopInfo?: ShopInfo;
  /**
   * Fixture for `getShopPolicies`. A thunk (like `refundOrder`) so a test can
   * return policies on the happy path OR simulate a fetch failure — the policy
   * import's "fail silently" boundary needs both. When unset the default Test
   * impl returns an empty list (the "no policies configured" case).
   */
  readonly shopPolicies?: () => Effect.Effect<
    ReadonlyArray<ShopPolicy>,
    ShopifyError
  >;
  /**
   * Fixture for `getOnlineStorePages`. A thunk for the same reason as
   * `shopPolicies` — the page import's silent boundary needs a failure
   * path (a pre-scope-widening connection fails this call). When unset
   * the default Test impl returns an empty list.
   */
  readonly onlineStorePages?: () => Effect.Effect<
    ReadonlyArray<ShopPage>,
    ShopifyError
  >;
  /**
   * Fixture for `listPickupLocations`. When unset the default Test impl
   * returns an empty list (the common "store offers no pickup" case).
   */
  readonly pickupLocations?: ReadonlyArray<PickupLocation>;
}

/**
 * In-memory ShopifyService for unit tests. Lookups against an empty map
 * fail with the appropriate `*NotFound` error — exactly the shape the
 * Live impl produces on 404, so tools and the runtime exercise the same
 * error paths under test as in production.
 */
export const ShopifyServiceTest = (fixtures: ShopifyTestFixtures = {}) =>
  Layer.succeed(
    ShopifyService,
    ShopifyService.of({
      getOrder: (_tenantId, orderId) => {
        const o = fixtures.orders?.get(orderId);
        return o
          ? Effect.succeed(o)
          : Effect.fail(new OrderNotFound({ orderId }));
      },
      getCustomer: (_tenantId, customerId) => {
        const c = fixtures.customers?.get(customerId);
        return c
          ? Effect.succeed(c)
          : Effect.fail(new CustomerNotFound({ query: customerId }));
      },
      getProduct: (_tenantId, productId) => {
        const p = fixtures.productsById?.get(productId);
        return p
          ? Effect.succeed(p)
          : Effect.fail(new ProductNotFound({ productId }));
      },
      searchProducts: (_tenantId, query, limit) =>
        Effect.succeed(
          (fixtures.searchProducts?.(query) ?? []).slice(
            0,
            Math.max(0, limit),
          ),
        ),
      getShopInfo: (tenantId) =>
        fixtures.shopInfo
          ? Effect.succeed(fixtures.shopInfo)
          : Effect.fail(new ShopifyAuthMissing({ tenantId })),
      getShopPolicies: (_tenantId) =>
        fixtures.shopPolicies ? fixtures.shopPolicies() : Effect.succeed([]),
      getOnlineStorePages: (_tenantId) =>
        fixtures.onlineStorePages
          ? fixtures.onlineStorePages()
          : Effect.succeed([]),
      listPickupLocations: (_tenantId) =>
        Effect.succeed(fixtures.pickupLocations ?? []),
      searchByEmail: (_tenantId, email) =>
        Effect.succeed(fixtures.customersByEmail?.get(email) ?? null),
      findOrderByName: (_tenantId, name) => {
        const normalized = name.startsWith("#") ? name : `#${name}`;
        return Effect.succeed(
          fixtures.ordersByName?.get(normalized) ??
            fixtures.ordersByName?.get(name) ??
            null,
        );
      },
      findOrderByConfirmationNumber: (_tenantId, confirmationNumber) =>
        Effect.succeed(
          fixtures.ordersByConfirmationNumber?.get(confirmationNumber.trim()) ??
            fixtures.ordersByConfirmationNumber?.get(confirmationNumber) ??
            null,
        ),
      findOrdersByEmail: (_tenantId, email, limit) =>
        Effect.succeed(
          (fixtures.ordersByEmail?.get(email) ?? []).slice(
            0,
            Math.max(0, limit),
          ),
        ),
      getFulfillment: (_tenantId, orderId) =>
        Effect.succeed(fixtures.fulfillments?.get(orderId) ?? []),
      refundOrder: (_tenantId, input) => {
        if (fixtures.refundOrder) {
          return fixtures.refundOrder(input);
        }
        // Default: synthesise a deterministic refund. Tests that care
        // about the exact id should override; tests that just need a
        // "refund happened" signal can read the synthesised id.
        const synthId = `gid://shopify/Refund/test-${
          input.idempotencyKey ?? input.orderId
        }`;
        return Effect.succeed<ShopifyRefund>({
          id: synthId,
          orderId: input.orderId,
          amount: input.amount,
          note: input.note,
          createdAt: new Date(0),
        });
      },
      getCustomerRefundHistory: (_tenantId, customerId) => {
        const hit = fixtures.customerRefundHistory?.get(customerId);
        if (hit) return Effect.succeed(hit);
        // Default: brand-new customer with no orders → no refunds → no
        // currency to report (we don't invent USD here).
        return Effect.succeed<CustomerRefundHistory>({
          ordersCount: 0,
          refundedOrdersCount: 0,
          totalRefundedAmount: null,
          firstOrderAt: null,
        });
      },
      listRecentOrderPiiPresence: (_tenantId, _limit) =>
        Effect.succeed(fixtures.recentOrderPiiPresence ?? []),
    }),
  );
