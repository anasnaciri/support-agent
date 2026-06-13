import { Effect, FiberRef, Layer } from "effect";
import { eq, sql } from "drizzle-orm";
import {
  AccountOpenRouterCredentialStore,
  decryptToStringWithKeys,
  encrypt,
  type AccountOpenRouterCredential,
  type PutAccountOpenRouterCredentialInput,
} from "@support-agent/services";
import { ConnectorStoreDbError } from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import {
  accountOpenrouterCredentials,
  type AccountOpenRouterCredentialRow,
} from "./schema.js";
import type { DrizzleDb } from "./client.js";

const wrap = <A>(promise: Promise<A>): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const present = (
  row: AccountOpenRouterCredentialRow,
  keys: ReadonlyArray<Buffer>,
): AccountOpenRouterCredential => ({
  organizationId: row.organizationId,
  apiKey: decryptToStringWithKeys(keys, row.apiKeyEncrypted),
  metadata: (row.metadata ?? {}) as Readonly<Record<string, unknown>>,
  status: row.status as "active" | "revoked",
  installedAt: row.installedAt,
  revokedAt: row.revokedAt,
  updatedAt: row.updatedAt,
});

/**
 * Live AccountOpenRouterCredentialStore backed by Postgres. Encrypts the
 * account BYOK key with AES-256-GCM on write and decrypts on read.
 *
 * Key rotation (audit S15): pass a key SET, primary first. Writes (re-)encrypt
 * with the primary (`keys[0]`); reads try every key, so a key roll keeps old
 * ciphertext readable until the row migrates on next write. A single `Buffer`
 * is accepted for back-compat (== a length-1 set).
 */
export const AccountOpenRouterCredentialStoreLive = (
  encryptionKeys: Buffer | ReadonlyArray<Buffer>,
) =>
  Layer.effect(
    AccountOpenRouterCredentialStore,
    Effect.gen(function* () {
      const keys = Array.isArray(encryptionKeys)
        ? encryptionKeys
        : [encryptionKeys as Buffer];
      const encryptionKey = keys[0]!;
      const defaultDb = yield* DbClient;
      const useDb = (): Effect.Effect<DrizzleDb> =>
        FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

      const put = (input: PutAccountOpenRouterCredentialInput) =>
        Effect.gen(function* () {
          const db = yield* useDb();
          const now = new Date();
          const encrypted = encrypt(encryptionKey, input.apiKey);
          const rows = yield* wrap(
            db
              .insert(accountOpenrouterCredentials)
              .values({
                organizationId: input.organizationId,
                apiKeyEncrypted: encrypted,
                ...(input.metadata !== undefined
                  ? { metadata: input.metadata }
                  : {}),
                status: "active",
                installedAt: now,
                revokedAt: null,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: accountOpenrouterCredentials.organizationId,
                set: {
                  apiKeyEncrypted: encrypted,
                  ...(input.metadata !== undefined
                    ? { metadata: input.metadata }
                    : {}),
                  status: "active",
                  revokedAt: null,
                  updatedAt: now,
                },
              })
              .returning(),
          );
          return present(rows[0]!, keys);
        });

      const get = (organizationId: string) =>
        Effect.gen(function* () {
          const db = yield* useDb();
          const rows = yield* wrap(
            db
              .select()
              .from(accountOpenrouterCredentials)
              .where(eq(accountOpenrouterCredentials.organizationId, organizationId))
              .limit(1),
          );
          return rows[0] ? present(rows[0], keys) : null;
        });

      const revoke = (organizationId: string) =>
        Effect.gen(function* () {
          const db = yield* useDb();
          const now = new Date();
          const rows = yield* wrap(
            db
              .update(accountOpenrouterCredentials)
              .set({ status: "revoked", revokedAt: now, updatedAt: now })
              .where(eq(accountOpenrouterCredentials.organizationId, organizationId))
              .returning({ organizationId: accountOpenrouterCredentials.organizationId }),
          );
          return rows.length > 0;
        });

      const patchMetadata = (
        organizationId: string,
        metadata: Readonly<Record<string, unknown>>,
      ) =>
        Effect.gen(function* () {
          const db = yield* useDb();
          const patch = JSON.stringify(metadata);
          const rows = yield* wrap(
            db
              .update(accountOpenrouterCredentials)
              .set({
                metadata: sql`${accountOpenrouterCredentials.metadata} || ${patch}::jsonb`,
                updatedAt: new Date(),
              })
              .where(eq(accountOpenrouterCredentials.organizationId, organizationId))
              .returning(),
          );
          return rows[0] ? present(rows[0], keys) : null;
        });

      return AccountOpenRouterCredentialStore.of({
        put,
        get,
        revoke,
        patchMetadata,
      });
    }),
  );
