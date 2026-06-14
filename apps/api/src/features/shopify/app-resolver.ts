import { Data, Effect } from "effect";
import { ShopifyAppProvisioningStore } from "@support-agent/services";
import type { ConnectorStoreDbError, TenantId } from "@support-agent/agent-core";

/**
 * Resolved Shopify *app* credentials (client_id + client_secret) — used to
 * run the OAuth handshake and verify webhook HMACs. `source` records whether
 * they came from a per-tenant pilot app or the deployment-wide SaaS app.
 */
export interface ResolvedShopifyApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: "tenant" | "global";
}

/** The single, deployment-wide Shopify app (SaaS path). `null` when a
 * pilot-only deployment ships no global app. */
export interface GlobalShopifyApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class ShopifyAppNotConfigured extends Data.TaggedError(
  "ShopifyAppNotConfigured",
)<{
  readonly tenantId?: string;
  readonly shopDomain?: string;
}> {}

/**
 * The install/OAuth path refused to resolve an app for the tenant. Distinct
 * from {@link ShopifyAppNotConfigured} (which means "no app exists anywhere"):
 * this means an app *could* be resolved but is not installable —
 *
 *   - `not_provisioned` — pilot mode (`SHOPIFY_CONNECT_REQUIRES_PROVISIONING`)
 *     with no provisioning row; the global fallback is deliberately forbidden.
 *   - `revoked` — a revoked provisioning row; the operator must re-provision
 *     before the merchant can (re)install.
 *
 * Callers map this to a 403 (operator action required), not a 500.
 */
export class ShopifyProvisioningRequired extends Data.TaggedError(
  "ShopifyProvisioningRequired",
)<{
  readonly tenantId?: string;
  readonly reason: "not_provisioned" | "revoked";
}> {}

/**
 * Resolve the Shopify app credentials for a known tenant — the install and
 * (state-bearing) callback paths, where the merchant-initiated flow carries
 * the tenant id.
 *
 * Install gating (A1/A2): a **revoked** provisioning row is never installable,
 * and in pilot mode (`requireProvisioning`) a tenant with **no** row is
 * refused rather than silently falling back to the global SaaS app. This is
 * the authoritative gate — the dashboard button state is only a UX hint.
 * Webhook verification uses {@link resolveShopifyAppForShop}, which still
 * resolves a revoked row's secret so compliance/uninstall webhooks verify.
 */
export const resolveShopifyAppForTenant = (
  tenantId: TenantId,
  global: GlobalShopifyApp | null,
  opts: { readonly requireProvisioning: boolean },
): Effect.Effect<
  ResolvedShopifyApp,
  ShopifyAppNotConfigured | ShopifyProvisioningRequired | ConnectorStoreDbError,
  ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.get(tenantId);
    if (row) {
      // A revoked pilot app is not installable. Do NOT fall back to the
      // global app — presence of a row means this is a pilot tenant bound to
      // its own app; the operator must re-provision to reactivate it.
      if (row.status === "revoked") {
        return yield* Effect.fail(
          new ShopifyProvisioningRequired({ tenantId, reason: "revoked" }),
        );
      }
      return {
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        source: "tenant",
      };
    }
    // No provisioning row. In pilot mode the global fallback is forbidden —
    // refuse the install so an unprovisioned tenant can't install against the
    // global app. In SaaS mode, fall back to the deployment-wide app.
    if (opts.requireProvisioning) {
      return yield* Effect.fail(
        new ShopifyProvisioningRequired({
          tenantId,
          reason: "not_provisioned",
        }),
      );
    }
    if (global) {
      return {
        clientId: global.clientId,
        clientSecret: global.clientSecret,
        source: "global",
      };
    }
    return yield* Effect.fail(new ShopifyAppNotConfigured({ tenantId }));
  });

/**
 * Resolve the Shopify app credentials for a shop domain — the webhook paths,
 * where the only routing hint is the (unauthenticated) shop header. The
 * resolved secret is then used to verify the HMAC; an unknown shop with no
 * global app fails closed.
 */
export const resolveShopifyAppForShop = (
  shopDomain: string,
  global: GlobalShopifyApp | null,
): Effect.Effect<
  ResolvedShopifyApp,
  ShopifyAppNotConfigured | ConnectorStoreDbError,
  ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.getByShop(shopDomain);
    // A row in ANY status (including `revoked`) keeps the shop on its own
    // app secret — a revoked app's compliance/uninstall webhooks must still
    // verify. Install gating is a separate concern (see
    // resolveShopifyAppForTenant).
    if (row) {
      return {
        clientId: row.clientId,
        clientSecret: row.clientSecret,
        source: "tenant",
      };
    }
    if (global) {
      return {
        clientId: global.clientId,
        clientSecret: global.clientSecret,
        source: "global",
      };
    }
    return yield* Effect.fail(new ShopifyAppNotConfigured({ shopDomain }));
  });
