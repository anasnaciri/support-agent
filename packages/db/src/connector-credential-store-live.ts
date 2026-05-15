import { Effect, FiberRef, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  ConnectorCredentialStore,
  decryptToString,
  encrypt,
  type ConnectorConnection,
  type ConnectorProvider,
  type PutConnectorInput,
} from "@support-agent/services";
import {
  ConnectorNotFound,
  ConnectorRevoked,
  ConnectorStoreDbError,
  TenantId as makeTenantId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { connectorConnections, type ConnectorConnectionRow } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  promise: Promise<A>,
): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const rowToConnection = (
  r: ConnectorConnectionRow,
  key: Buffer,
): ConnectorConnection => ({
  tenantId: makeTenantId(r.tenantId),
  provider: r.provider as ConnectorProvider,
  shopDomain: r.shopDomain,
  accessToken: decryptToString(key, r.accessTokenEncrypted),
  scopes: r.scopes,
  apiVersion: r.apiVersion,
  installedAt: r.installedAt,
  status: r.status as "active" | "revoked",
});

/**
 * Live ConnectorCredentialStore backed by Postgres. Encrypts the access
 * token column with AES-256-GCM on write and decrypts on read using the
 * key passed in at Layer-build time.
 *
 * Upsert semantics on `put`: collapses the (tenant, provider, shopDomain)
 * unique key so re-installing the same store overwrites the previous
 * token + scopes and clears the `revoked_at` flag.
 */
export const ConnectorCredentialStoreLive = (encryptionKey: Buffer) =>
  Layer.effect(
    ConnectorCredentialStore,
    Effect.gen(function* () {
      const defaultDb = yield* DbClient;

      const put = (input: PutConnectorInput) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const encrypted = encrypt(encryptionKey, input.accessToken);
          const id = randomUUID();
          const now = new Date();
          const rows = yield* wrap(
            db
              .insert(connectorConnections)
              .values({
                id,
                tenantId: input.tenantId,
                provider: input.provider,
                shopDomain: input.shopDomain,
                accessTokenEncrypted: encrypted,
                scopes: [...input.scopes],
                ...(input.apiVersion !== undefined
                  ? { apiVersion: input.apiVersion }
                  : {}),
                status: "active",
                installedAt: now,
                revokedAt: null,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  connectorConnections.tenantId,
                  connectorConnections.provider,
                  connectorConnections.shopDomain,
                ],
                set: {
                  accessTokenEncrypted: encrypted,
                  scopes: [...input.scopes],
                  ...(input.apiVersion !== undefined
                    ? { apiVersion: input.apiVersion }
                    : {}),
                  status: "active",
                  revokedAt: null,
                  updatedAt: now,
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
          return rowToConnection(row, encryptionKey);
        });

      const get = (
        tenantId: TenantId,
        provider: ConnectorProvider,
        shopDomain?: string,
      ): Effect.Effect<
        ConnectorConnection,
        ConnectorNotFound | ConnectorRevoked | ConnectorStoreDbError
      > =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            shopDomain !== undefined
              ? db
                  .select()
                  .from(connectorConnections)
                  .where(
                    and(
                      eq(connectorConnections.tenantId, tenantId),
                      eq(connectorConnections.provider, provider),
                      eq(connectorConnections.shopDomain, shopDomain),
                    ),
                  )
                  .limit(1)
              : db
                  .select()
                  .from(connectorConnections)
                  .where(
                    and(
                      eq(connectorConnections.tenantId, tenantId),
                      eq(connectorConnections.provider, provider),
                    ),
                  )
                  .limit(1),
          );
          const row = rows[0];
          if (!row) {
            return yield* Effect.fail(
              new ConnectorNotFound({
                tenantId,
                provider,
                shopDomain: shopDomain ?? null,
              }),
            );
          }
          if (row.status === "revoked") {
            return yield* Effect.fail(
              new ConnectorRevoked({
                tenantId,
                provider,
                shopDomain: shopDomain ?? null,
              }),
            );
          }
          return rowToConnection(row, encryptionKey);
        });

      const revoke = (
        tenantId: TenantId,
        provider: ConnectorProvider,
        shopDomain: string,
      ): Effect.Effect<void, ConnectorNotFound | ConnectorStoreDbError> =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const now = new Date();
          const rows = yield* wrap(
            db
              .update(connectorConnections)
              .set({ status: "revoked", revokedAt: now, updatedAt: now })
              .where(
                and(
                  eq(connectorConnections.tenantId, tenantId),
                  eq(connectorConnections.provider, provider),
                  eq(connectorConnections.shopDomain, shopDomain),
                ),
              )
              .returning({ id: connectorConnections.id }),
          );
          if (rows.length === 0) {
            return yield* Effect.fail(
              new ConnectorNotFound({ tenantId, provider, shopDomain }),
            );
          }
        });

      const listForTenant = (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(connectorConnections)
              .where(eq(connectorConnections.tenantId, tenantId)),
          );
          return rows.map((r) => rowToConnection(r, encryptionKey));
        });

      return ConnectorCredentialStore.of({
        put,
        get,
        revoke,
        listForTenant,
      });
    }),
  );
