import { randomUUID } from "node:crypto";
import { Effect, FiberRef, Layer } from "effect";
import { eq, sql } from "drizzle-orm";
import {
  decryptToString,
  encrypt,
  ShopifyAppProvisioningStore,
  type PutShopifyAppProvisioningInput,
  type ShopifyAppProvisioning,
  type ShopifyAppProvisioningStatus,
} from "@support-agent/services";
import {
  ConnectorStoreDbError,
  TenantId as makeTenantId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import {
  shopifyAppProvisioning,
  type ShopifyAppProvisioningRow,
} from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  promise: Promise<A>,
): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const rowToProvisioning = (
  r: ShopifyAppProvisioningRow,
  key: Buffer,
): ShopifyAppProvisioning => ({
  tenantId: makeTenantId(r.tenantId),
  clientId: r.clientId,
  clientSecret: decryptToString(key, r.clientSecretEncrypted),
  shopDomain: r.shopDomain,
  status: r.status as ShopifyAppProvisioningStatus,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * Live ShopifyAppProvisioningStore backed by Postgres. Encrypts the
 * `client_secret` column with AES-256-GCM on write and decrypts on read.
 *
 * Upsert on `put` collapses the per-tenant unique key, rotating the
 * credentials — `shop_domain` survives so re-provisioning doesn't disturb a
 * live install, and a `revoked` status is reactivated to `ready` (A2) while a
 * live `ready`/`connected` status is preserved.
 */
export const ShopifyAppProvisioningStoreLive = (encryptionKey: Buffer) =>
  Layer.effect(
    ShopifyAppProvisioningStore,
    Effect.gen(function* () {
      const defaultDb = yield* DbClient;

      const put = (input: PutShopifyAppProvisioningInput) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const encrypted = encrypt(encryptionKey, input.clientSecret);
          const now = new Date();
          const rows = yield* wrap(
            db
              .insert(shopifyAppProvisioning)
              .values({
                id: randomUUID(),
                tenantId: input.tenantId,
                clientId: input.clientId,
                clientSecretEncrypted: encrypted,
                status: "ready",
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: shopifyAppProvisioning.tenantId,
                set: {
                  clientId: input.clientId,
                  clientSecretEncrypted: encrypted,
                  updatedAt: now,
                  // Re-provisioning a REVOKED row reactivates it to `ready`
                  // so re-entering credentials un-blocks the install (A2). A
                  // live `ready`/`connected` status is preserved.
                  status: sql`CASE WHEN ${shopifyAppProvisioning.status} = 'revoked' THEN 'ready' ELSE ${shopifyAppProvisioning.status} END`,
                },
              })
              .returning(),
          );
          const row = rows[0];
          if (!row) {
            return yield* Effect.fail(
              new ConnectorStoreDbError({
                cause: new Error("upsert returned no row"),
              }),
            );
          }
          return rowToProvisioning(row, encryptionKey);
        });

      const get = (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(shopifyAppProvisioning)
              .where(eq(shopifyAppProvisioning.tenantId, tenantId))
              .limit(1),
          );
          const row = rows[0];
          return row ? rowToProvisioning(row, encryptionKey) : null;
        });

      const getByShop = (shopDomain: string) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(shopifyAppProvisioning)
              .where(eq(shopifyAppProvisioning.shopDomain, shopDomain))
              .limit(1),
          );
          const row = rows[0];
          return row ? rowToProvisioning(row, encryptionKey) : null;
        });

      const markConnected = (tenantId: TenantId, shopDomain: string) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          yield* wrap(
            db
              .update(shopifyAppProvisioning)
              .set({
                shopDomain,
                status: "connected",
                updatedAt: new Date(),
              })
              .where(eq(shopifyAppProvisioning.tenantId, tenantId)),
          );
        });

      const revoke = (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          yield* wrap(
            db
              .update(shopifyAppProvisioning)
              .set({ status: "revoked", updatedAt: new Date() })
              .where(eq(shopifyAppProvisioning.tenantId, tenantId)),
          );
        });

      return ShopifyAppProvisioningStore.of({
        put,
        get,
        getByShop,
        markConnected,
        revoke,
      });
    }),
  );
