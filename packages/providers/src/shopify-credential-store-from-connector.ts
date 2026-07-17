import { Effect, Layer } from "effect";
import {
  ShopifyAuthMissing,
  type TenantId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ShopifyCredentialStore,
  type ShopifyCredentials,
} from "@support-agent/services";
import { reportConnectorHealth } from "./connector-health.js";

/**
 * Resolves a tenant's Shopify credentials via the DB-backed
 * `ConnectorCredentialStore`. This is the production credential source
 * once the merchant has installed our managed Shopify app — `apps/api`'s
 * OAuth callback writes the offline access token into
 * `connector_connections`, and `ShopifyService` reads it back through
 * this Layer.
 *
 * Maps every connector-side error (`ConnectorNotFound`, `ConnectorRevoked`,
 * `ConnectorStoreDbError`) to a single `ShopifyAuthMissing` so that
 * tools see exactly one auth-failure tag at their boundary instead of
 * having to enumerate connector-store internals.
 *
 * The `apiVersion` default mirrors `ShopifyCredentialStoreFromEnv` so a
 * connection row inserted without an explicit api_version still works.
 */
export const ShopifyCredentialStoreFromConnector = (opts: {
  readonly apiVersionDefault?: string;
} = {}) =>
  Layer.effect(
    ShopifyCredentialStore,
    Effect.gen(function* () {
      const store = yield* ConnectorCredentialStore;
      const apiVersionDefault = opts.apiVersionDefault ?? "2026-04";

      return ShopifyCredentialStore.of({
        get: (tenantId: TenantId) =>
          store.get(tenantId, "shopify").pipe(
            Effect.map(
              (conn): ShopifyCredentials => ({
                shopDomain: conn.shopDomain,
                accessToken: conn.accessToken,
                apiVersion: conn.apiVersion ?? apiVersionDefault,
              }),
            ),
            Effect.mapError(() => new ShopifyAuthMissing({ tenantId })),
          ),
        reportHealth: (tenantId, state, reason) =>
          store.get(tenantId, "shopify").pipe(
            Effect.flatMap((connection) =>
              reportConnectorHealth(store, connection, state, reason),
            ),
            Effect.catchAll(() => Effect.void),
          ),
      });
    }),
  );
