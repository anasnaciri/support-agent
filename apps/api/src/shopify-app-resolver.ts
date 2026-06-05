import { Data, Effect } from "effect";
import {
  ShopifyAppProvisioningStore,
  type ShopifyAppProvisioning,
} from "@support-agent/services";
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

const fromRowOrGlobal = (
  row: ShopifyAppProvisioning | null,
  global: GlobalShopifyApp | null,
  ctx: { readonly tenantId?: string; readonly shopDomain?: string },
): Effect.Effect<ResolvedShopifyApp, ShopifyAppNotConfigured> => {
  // Presence of a provisioning row is the pilot-vs-SaaS switch. A row in any
  // status (including `revoked`) keeps the tenant on its own app — the app
  // secret still has to verify that shop's webhooks, and install gating is a
  // separate concern from credential resolution.
  if (row) {
    return Effect.succeed({
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      source: "tenant",
    });
  }
  if (global) {
    return Effect.succeed({
      clientId: global.clientId,
      clientSecret: global.clientSecret,
      source: "global",
    });
  }
  return Effect.fail(new ShopifyAppNotConfigured(ctx));
};

/**
 * Resolve the Shopify app credentials for a known tenant — the install and
 * (state-bearing) callback paths, where the merchant-initiated flow carries
 * the tenant id.
 */
export const resolveShopifyAppForTenant = (
  tenantId: TenantId,
  global: GlobalShopifyApp | null,
): Effect.Effect<
  ResolvedShopifyApp,
  ShopifyAppNotConfigured | ConnectorStoreDbError,
  ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.get(tenantId);
    return yield* fromRowOrGlobal(row, global, { tenantId });
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
    return yield* fromRowOrGlobal(row, global, { shopDomain });
  });
