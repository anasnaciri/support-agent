import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { DbClient, tenants } from "@support-agent/db";

/**
 * Look up a tenant by Shopify shop domain without auto-creating. Returns
 * the tenant id, or `null` if no tenant is linked to that shop.
 *
 * Used by the `app/uninstalled` webhook: if Shopify fires an uninstall for
 * a shop we don't know, the webhook is a no-op — we MUST NOT mint a tenant
 * here (that's only valid on install).
 */
export const findTenantByShop = (
  shopDomain: string,
): Effect.Effect<string | null, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
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
    const db = yield* DbClient;

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
