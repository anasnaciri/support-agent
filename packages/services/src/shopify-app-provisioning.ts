import { Context, Effect, Layer } from "effect";
import {
  ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

export type ShopifyAppProvisioningStatus = "ready" | "connected" | "revoked";

/**
 * One operator-provisioned Shopify custom app, scoped to a tenant. This is
 * the *app* credential (client_id + client_secret) used to run the per-tenant
 * OAuth handshake and verify that tenant's webhooks — distinct from, and
 * upstream of, the per-merchant access token in `ConnectorCredentialStore`.
 */
export interface ShopifyAppProvisioning {
  readonly tenantId: TenantId;
  readonly clientId: string;
  /** Decrypted on read by the Live layer; plaintext in the test layer. */
  readonly clientSecret: string;
  /**
   * The shop the merchant connected, learned at the OAuth callback. `null`
   * until the merchant completes Connect.
   */
  readonly shopDomain: string | null;
  readonly status: ShopifyAppProvisioningStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PutShopifyAppProvisioningInput {
  readonly tenantId: TenantId;
  readonly clientId: string;
  readonly clientSecret: string;
}

// ============================================================
// Tag
// ============================================================

/**
 * Per-tenant store of Shopify custom-app credentials (pilot custom
 * distribution). The presence of a row is the pilot-vs-SaaS switch — see
 * the credential resolver. The Live impl encrypts the `client_secret`
 * column on write and decrypts on read; the test impl keeps it plain.
 *
 * `get` / `getByShop` return `null` (not an error) when no row exists, so
 * the resolver can cleanly fall back to the global env app.
 */
export class ShopifyAppProvisioningStore extends Context.Tag(
  "ShopifyAppProvisioningStore",
)<
  ShopifyAppProvisioningStore,
  {
    /**
     * Upsert the app credentials for a tenant (operator provisioning). On
     * an existing row this rotates `client_id` / `client_secret` and
     * preserves `shop_domain`, so re-entering credentials does not un-connect
     * a live install. A `revoked` row is reactivated to `ready` (re-entering
     * credentials must un-block the install — A2); a `ready`/`connected`
     * status is otherwise preserved.
     */
    readonly put: (
      input: PutShopifyAppProvisioningInput,
    ) => Effect.Effect<ShopifyAppProvisioning, ConnectorStoreDbError>;

    readonly get: (
      tenantId: TenantId,
    ) => Effect.Effect<ShopifyAppProvisioning | null, ConnectorStoreDbError>;

    readonly getByShop: (
      shopDomain: string,
    ) => Effect.Effect<ShopifyAppProvisioning | null, ConnectorStoreDbError>;

    /**
     * Stamp the shop the merchant connected and flip status to `connected`.
     * Idempotent; a no-op if the tenant has no provisioning row.
     */
    readonly markConnected: (
      tenantId: TenantId,
      shopDomain: string,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /** Flip status to `revoked` (uninstall / admin). Idempotent. */
    readonly revoke: (
      tenantId: TenantId,
    ) => Effect.Effect<void, ConnectorStoreDbError>;
  }
>() {}

// ============================================================
// Test Layer — in-memory, plain (no encryption)
// ============================================================

export const ShopifyAppProvisioningStoreTest = (
  seed: ReadonlyArray<ShopifyAppProvisioning> = [],
) =>
  Layer.sync(ShopifyAppProvisioningStore, () => {
    const store = new Map<string, ShopifyAppProvisioning>();
    for (const row of seed) store.set(row.tenantId, row);

    const put: (
      input: PutShopifyAppProvisioningInput,
    ) => Effect.Effect<ShopifyAppProvisioning, ConnectorStoreDbError> = (
      input,
    ) =>
      Effect.sync(() => {
        const prior = store.get(input.tenantId);
        const now = new Date();
        const row: ShopifyAppProvisioning = {
          tenantId: input.tenantId,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          shopDomain: prior?.shopDomain ?? null,
          // Re-provisioning a REVOKED row reactivates it to `ready` so
          // re-entering credentials un-blocks the install (A2). A live
          // `ready`/`connected` status is preserved — rotating the secret of
          // a connected app must not un-connect it.
          status:
            prior && prior.status !== "revoked" ? prior.status : "ready",
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
        };
        store.set(input.tenantId, row);
        return row;
      });

    const get: (
      tenantId: TenantId,
    ) => Effect.Effect<ShopifyAppProvisioning | null, ConnectorStoreDbError> = (
      tenantId,
    ) => Effect.sync(() => store.get(tenantId) ?? null);

    const getByShop: (
      shopDomain: string,
    ) => Effect.Effect<ShopifyAppProvisioning | null, ConnectorStoreDbError> = (
      shopDomain,
    ) =>
      Effect.sync(
        () =>
          Array.from(store.values()).find(
            (r) => r.shopDomain === shopDomain,
          ) ?? null,
      );

    const markConnected: (
      tenantId: TenantId,
      shopDomain: string,
    ) => Effect.Effect<void, ConnectorStoreDbError> = (tenantId, shopDomain) =>
      Effect.sync(() => {
        const prior = store.get(tenantId);
        if (prior) {
          store.set(tenantId, {
            ...prior,
            shopDomain,
            status: "connected",
            updatedAt: new Date(),
          });
        }
      });

    const revoke: (
      tenantId: TenantId,
    ) => Effect.Effect<void, ConnectorStoreDbError> = (tenantId) =>
      Effect.sync(() => {
        const prior = store.get(tenantId);
        if (prior) {
          store.set(tenantId, {
            ...prior,
            status: "revoked",
            updatedAt: new Date(),
          });
        }
      });

    return ShopifyAppProvisioningStore.of({
      put,
      get,
      getByShop,
      markConnected,
      revoke,
    });
  });
