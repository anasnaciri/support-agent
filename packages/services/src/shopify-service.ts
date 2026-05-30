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
  type ShopifyRefund,
  type TenantId,
  CustomerNotFound,
  OrderNotFound,
  ProductNotFound,
  RefundFailed,
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
  }
>() {}

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
   * Map from order *name* (with or without leading `#`) to ShopifyOrder.
   * Keys are normalized to `#XXXX` on lookup so tests can write either
   * `"#1001"` or `"1001"` in the fixture.
   */
  readonly ordersByName?: ReadonlyMap<string, ShopifyOrder>;
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
    }),
  );
