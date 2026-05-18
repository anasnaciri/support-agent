import { randomUUID } from "node:crypto";
import { Effect, FiberRef } from "effect";
import { and, eq, ne } from "drizzle-orm";
import {
  connectorConnections,
  CurrentTxRef,
  DbClient,
  tenants,
  type DrizzleDb,
} from "@support-agent/db";

const useDb = (): Effect.Effect<DrizzleDb, never, DbClient> =>
  FiberRef.get(CurrentTxRef).pipe(
    Effect.flatMap((tx) => (tx ? Effect.succeed(tx) : DbClient)),
  );

export class ShopifyShopAlreadyConnected extends Error {
  readonly _tag = "ShopifyShopAlreadyConnected";

  constructor(
    readonly shopDomain: string,
    readonly ownerTenantId: string,
    readonly requestedTenantId: string,
  ) {
    super(
      `shop ${shopDomain} is already connected to tenant ${ownerTenantId}`,
    );
  }
}

export class ShopifyInstallTenantNotFound extends Error {
  readonly _tag = "ShopifyInstallTenantNotFound";

  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} was not found for Shopify install`);
  }
}

/**
 * Look up a tenant by Shopify shop domain without auto-creating. Active
 * connector ownership wins; `tenants.shopify_domain` is the fallback for
 * uninstalled/compliance paths where the connector may already be revoked.
 * Returns the tenant id, or `null` if no tenant is linked to that shop.
 *
 * Used by the `app/uninstalled` webhook: if Shopify fires an uninstall for
 * a shop we don't know, the webhook is a no-op — we MUST NOT mint a tenant
 * here (that's only valid on install).
 */
export const findTenantByShop = (
  shopDomain: string,
): Effect.Effect<string | null, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* useDb();
    const activeRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: connectorConnections.tenantId })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.provider, "shopify"),
              eq(connectorConnections.shopDomain, shopDomain),
              eq(connectorConnections.status, "active"),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new Error(`findTenantByShop active select failed: ${String(cause)}`),
    });
    if (activeRows[0]) return activeRows[0].id;

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.shopifyDomain, shopDomain))
          .limit(1),
      catch: (cause) =>
        new Error(`findTenantByShop select failed: ${String(cause)}`),
    });
    return rows[0]?.id ?? null;
  });

export const assertShopifyShopConnectable = (
  shopDomain: string,
  requestedTenantId: string,
): Effect.Effect<void, Error | ShopifyShopAlreadyConnected, DbClient> =>
  Effect.gen(function* () {
    const db = yield* useDb();
    const activeRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ tenantId: connectorConnections.tenantId })
          .from(connectorConnections)
          .where(
            and(
              eq(connectorConnections.provider, "shopify"),
              eq(connectorConnections.shopDomain, shopDomain),
              eq(connectorConnections.status, "active"),
              ne(connectorConnections.tenantId, requestedTenantId),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new Error(
          `assertShopifyShopConnectable active select failed: ${String(cause)}`,
        ),
    });

    const activeOwner = activeRows[0];
    if (activeOwner) {
      return yield* Effect.fail(
        new ShopifyShopAlreadyConnected(
          shopDomain,
          activeOwner.tenantId,
          requestedTenantId,
        ),
      );
    }
  });

export interface ClaimShopifyShopResult {
  readonly previousTenantId: string | null;
  readonly transferred: boolean;
}

/**
 * Bind a Shopify shop to the tenant that just completed OAuth.
 *
 * Active ownership by another tenant is rejected. Revoked/stale ownership
 * can transfer after OAuth succeeds, because the fresh Shopify code proves
 * the new account has admin access to the store.
 */
export const claimShopifyShopForTenant = (
  shopDomain: string,
  requestedTenantId: string,
): Effect.Effect<
  ClaimShopifyShopResult,
  Error | ShopifyShopAlreadyConnected | ShopifyInstallTenantNotFound,
  DbClient
> =>
  Effect.gen(function* () {
    yield* assertShopifyShopConnectable(shopDomain, requestedTenantId);

    const db = yield* useDb();
    const requestedRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, requestedTenantId))
          .limit(1),
      catch: (cause) =>
        new Error(
          `claimShopifyShopForTenant tenant select failed: ${String(cause)}`,
        ),
    });
    if (!requestedRows[0]) {
      return yield* Effect.fail(
        new ShopifyInstallTenantNotFound(requestedTenantId),
      );
    }

    const ownerRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.shopifyDomain, shopDomain))
          .limit(1),
      catch: (cause) =>
        new Error(
          `claimShopifyShopForTenant owner select failed: ${String(cause)}`,
        ),
    });
    const previousTenantId = ownerRows[0]?.id ?? null;
    if (previousTenantId === requestedTenantId) {
      return { previousTenantId: null, transferred: false };
    }

    if (previousTenantId) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(tenants)
            .set({ shopifyDomain: null })
            .where(eq(tenants.id, previousTenantId)),
        catch: (cause) =>
          new Error(
            `claimShopifyShopForTenant owner clear failed: ${String(cause)}`,
          ),
      });
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(tenants)
          .set({ shopifyDomain: shopDomain })
          .where(eq(tenants.id, requestedTenantId)),
      catch: (cause) =>
        new Error(
          `claimShopifyShopForTenant tenant update failed: ${String(cause)}`,
        ),
    });

    return {
      previousTenantId,
      transferred: previousTenantId !== null,
    };
  });

/**
 * Look up a tenant by Shopify shop domain. If none exists, mint one and
 * link it to the shop.
 *
 * Used by the OAuth callback when no `state` is present — Shopify's
 * Custom Distribution install link goes directly to Shopify's authorize
 * page (we don't see the merchant first), so by the time we get the
 * callback we have to figure out which tenant owns this shop from the
 * shop domain alone.
 *
 * Race safety: the partial unique index `tenants_shopify_domain_unique`
 * enforces one tenant per shop. Two concurrent installs of the same shop
 * collapse at the `ON CONFLICT DO NOTHING` — the loser re-SELECTs and
 * picks up the winner's row.
 */
export const resolveTenantByShop = (
  shopDomain: string,
): Effect.Effect<string, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* useDb();

    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.shopifyDomain, shopDomain))
          .limit(1),
      catch: (cause) =>
        new Error(`resolveTenantByShop select failed: ${String(cause)}`),
    });
    if (existing[0]) return existing[0].id;

    const id = randomUUID();
    // `onConflictDoNothing()` without a target matches ANY unique-constraint
    // violation, which is what we want against the partial unique index on
    // `tenants(shopify_domain) WHERE shopify_domain IS NOT NULL`. The
    // typed `{ target }` form would generate `ON CONFLICT (col) DO NOTHING`,
    // which Postgres rejects when the matching index is partial unless the
    // index predicate is included (Drizzle's builder doesn't surface that).
    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(tenants)
          .values({ id, name: shopDomain, shopifyDomain: shopDomain })
          .onConflictDoNothing(),
      catch: (cause) =>
        new Error(`resolveTenantByShop insert failed: ${String(cause)}`),
    });

    const after = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.shopifyDomain, shopDomain))
          .limit(1),
      catch: (cause) =>
        new Error(`resolveTenantByShop re-select failed: ${String(cause)}`),
    });
    if (!after[0]) {
      return yield* Effect.fail(
        new Error(
          `resolveTenantByShop: row vanished between insert and select for shop ${shopDomain}`,
        ),
      );
    }
    return after[0].id;
  });
