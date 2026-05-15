import { Context, Effect, Layer } from "effect";
import {
  ConnectorNotFound,
  ConnectorRevoked,
  type ConnectorStoreDbError,
  type ConnectorStoreError,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

/**
 * The provider identifiers we know about. Kept narrow on purpose — adding
 * a new connector means widening this union AND the schema CHECK
 * constraint together, so they can't drift.
 */
export type ConnectorProvider = "shopify" | "gmail" | "outlook";

export interface ConnectorConnection {
  readonly tenantId: TenantId;
  readonly provider: ConnectorProvider;
  /** "" for non-shoppable connectors (gmail/outlook), otherwise the myshopify domain. */
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly scopes: ReadonlyArray<string>;
  readonly apiVersion: string | null;
  readonly installedAt: Date;
  readonly status: "active" | "revoked";
}

export interface PutConnectorInput {
  readonly tenantId: TenantId;
  readonly provider: ConnectorProvider;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly scopes: ReadonlyArray<string>;
  readonly apiVersion?: string;
}

// ============================================================
// Tag
// ============================================================

/**
 * Per-tenant store of connector access tokens. Live impl encrypts the
 * token column on write and decrypts on read; test impls keep it in
 * memory plain.
 *
 * The store enforces:
 *   - one (tenant, provider, shopDomain) → one row (upsert on put)
 *   - `revoke` flips `status` to 'revoked' + sets `revokedAt`; subsequent
 *     `get` calls return `ConnectorRevoked` so callers fail loudly
 *     instead of trying a dead token.
 */
export class ConnectorCredentialStore extends Context.Tag(
  "ConnectorCredentialStore",
)<
  ConnectorCredentialStore,
  {
    readonly put: (
      input: PutConnectorInput,
    ) => Effect.Effect<ConnectorConnection, ConnectorStoreDbError>;

    readonly get: (
      tenantId: TenantId,
      provider: ConnectorProvider,
      shopDomain?: string,
    ) => Effect.Effect<
      ConnectorConnection,
      ConnectorNotFound | ConnectorRevoked | ConnectorStoreDbError
    >;

    readonly revoke: (
      tenantId: TenantId,
      provider: ConnectorProvider,
      shopDomain: string,
    ) => Effect.Effect<void, ConnectorNotFound | ConnectorStoreDbError>;

    readonly listForTenant: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<ConnectorConnection>, ConnectorStoreDbError>;
  }
>() {}

// ============================================================
// Test Layer — in-memory, plain (no encryption)
// ============================================================

/**
 * In-memory ConnectorCredentialStore for tests. Stores plaintext tokens —
 * the encrypt/decrypt path is exercised only by the Live layer + its
 * dedicated integration tests.
 */
export const ConnectorCredentialStoreTest = (
  seed: ReadonlyArray<ConnectorConnection> = [],
) =>
  Layer.sync(ConnectorCredentialStore, () => {
    const store = new Map<string, ConnectorConnection>();
    const key = (
      t: TenantId,
      p: ConnectorProvider,
      s: string,
    ) => `${t}\x00${p}\x00${s}`;
    for (const row of seed) {
      store.set(key(row.tenantId, row.provider, row.shopDomain), row);
    }

    const put: (
      input: PutConnectorInput,
    ) => Effect.Effect<ConnectorConnection, ConnectorStoreDbError> = (input) =>
      Effect.sync(() => {
        const row: ConnectorConnection = {
          tenantId: input.tenantId,
          provider: input.provider,
          shopDomain: input.shopDomain,
          accessToken: input.accessToken,
          scopes: input.scopes,
          apiVersion: input.apiVersion ?? null,
          installedAt: new Date(),
          status: "active",
        };
        store.set(key(input.tenantId, input.provider, input.shopDomain), row);
        return row;
      });

    const get: (
      tenantId: TenantId,
      provider: ConnectorProvider,
      shopDomain?: string,
    ) => Effect.Effect<ConnectorConnection, ConnectorStoreError> = (
      tenantId,
      provider,
      shopDomain,
    ) =>
      Effect.suspend((): Effect.Effect<ConnectorConnection, ConnectorStoreError> => {
        const direct =
          shopDomain !== undefined
            ? store.get(key(tenantId, provider, shopDomain))
            : Array.from(store.values()).find(
                (r) => r.tenantId === tenantId && r.provider === provider,
              );
        if (!direct) {
          return Effect.fail(
            new ConnectorNotFound({
              tenantId,
              provider,
              shopDomain: shopDomain ?? null,
            }),
          );
        }
        if (direct.status === "revoked") {
          return Effect.fail(
            new ConnectorRevoked({
              tenantId,
              provider,
              shopDomain: shopDomain ?? null,
            }),
          );
        }
        return Effect.succeed(direct);
      });

    const revoke: (
      tenantId: TenantId,
      provider: ConnectorProvider,
      shopDomain: string,
    ) => Effect.Effect<void, ConnectorNotFound | ConnectorStoreDbError> = (
      tenantId,
      provider,
      shopDomain,
    ) =>
      Effect.suspend((): Effect.Effect<
        void,
        ConnectorNotFound | ConnectorStoreDbError
      > => {
        const k = key(tenantId, provider, shopDomain);
        const row = store.get(k);
        if (!row) {
          return Effect.fail(
            new ConnectorNotFound({
              tenantId,
              provider,
              shopDomain,
            }),
          );
        }
        store.set(k, { ...row, status: "revoked" });
        return Effect.void;
      });

    const listForTenant: (
      tenantId: TenantId,
    ) => Effect.Effect<
      ReadonlyArray<ConnectorConnection>,
      ConnectorStoreDbError
    > = (tenantId) =>
      Effect.sync(() =>
        Array.from(store.values()).filter((r) => r.tenantId === tenantId),
      );

    return ConnectorCredentialStore.of({
      put,
      get,
      revoke,
      listForTenant,
    });
  });
