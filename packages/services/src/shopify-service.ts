import { Context, Effect, Layer } from "effect";
import {
  type CustomerId,
  type OrderId,
  type ShopifyCustomer,
  type ShopifyError,
  type ShopifyFulfillment,
  type ShopifyOrder,
  type TenantId,
  CustomerNotFound,
  OrderNotFound,
} from "@support-agent/agent-core";

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
  }
>() {}

// ============================================================
// Test layer — in-memory fixtures
// ============================================================

export interface ShopifyTestFixtures {
  readonly orders?: ReadonlyMap<OrderId, ShopifyOrder>;
  readonly customers?: ReadonlyMap<CustomerId, ShopifyCustomer>;
  readonly customersByEmail?: ReadonlyMap<string, ShopifyCustomer>;
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
    }),
  );
