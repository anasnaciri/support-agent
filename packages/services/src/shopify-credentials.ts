import { Context, Effect, Layer } from "effect";
import {
  type TenantId,
  ShopifyAuthMissing,
} from "@support-agent/agent-core";

/**
 * Credentials for a tenant's Shopify connection. For Phase 2 we use
 * Shopify "custom app" admin tokens (one per store, no OAuth ceremony).
 * Multi-tenant OAuth lands later — this shape stays compatible.
 */
export interface ShopifyCredentials {
  readonly shopDomain: string; // "shop-name.myshopify.com" — no protocol
  readonly accessToken: string;
  readonly apiVersion: string; // e.g. "2025-01"
}

export class ShopifyCredentialStore extends Context.Tag(
  "ShopifyCredentialStore",
)<
  ShopifyCredentialStore,
  {
    readonly get: (
      tenantId: TenantId,
    ) => Effect.Effect<ShopifyCredentials, ShopifyAuthMissing>;
  }
>() {}

/**
 * Static in-memory credential store for tests and single-tenant dev.
 * Maps tenant id → credentials; tenants not in the map fail with
 * `ShopifyAuthMissing`. The "Any" variant returns the same creds for
 * every tenant — handy for smoke tests against a real dev store.
 */
export const ShopifyCredentialStoreStatic = (
  creds: ReadonlyMap<TenantId, ShopifyCredentials>,
) =>
  Layer.succeed(
    ShopifyCredentialStore,
    ShopifyCredentialStore.of({
      get: (tenantId) => {
        const c = creds.get(tenantId);
        return c
          ? Effect.succeed(c)
          : Effect.fail(new ShopifyAuthMissing({ tenantId }));
      },
    }),
  );

export const ShopifyCredentialStoreAny = (creds: ShopifyCredentials) =>
  Layer.succeed(
    ShopifyCredentialStore,
    ShopifyCredentialStore.of({
      get: () => Effect.succeed(creds),
    }),
  );
