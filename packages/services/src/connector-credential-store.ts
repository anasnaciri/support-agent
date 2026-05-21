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
export type ConnectorProvider =
  | "shopify"
  | "gmail"
  | "outlook"
  | "openrouter"
  | "anthropic"
  | "openai";

export interface ConnectorConnection {
  readonly tenantId: TenantId;
  readonly provider: ConnectorProvider;
  /**
   * Provider-specific second key. For Shopify it's the `*.myshopify.com`
   * domain; for Gmail it's the mailbox address (`user@gmail.com`); for
   * Outlook the UPN. The unique key on (tenant, provider, shopDomain) lets a
   * single tenant install multiple shops / mailboxes per provider.
   */
  readonly shopDomain: string;
  readonly accessToken: string;
  /**
   * Long-lived refresh token for OAuth providers (Gmail, Outlook). `null`
   * for static-token providers (Shopify offline access). Used by the
   * connector's HTTP layer to mint a fresh access token when the current
   * one is past `tokenExpiresAt`.
   */
  readonly refreshToken: string | null;
  /**
   * Absolute time at which `accessToken` expires. `null` for non-expiring
   * tokens (Shopify offline access).
   */
  readonly tokenExpiresAt: Date | null;
  /**
   * Per-connector state that doesn't deserve its own column. Today: Gmail's
   * `historyId` (last processed mailbox history cursor) and `watchExpiresAt`
   * (Gmail watch lease expiry). Always an object — never null.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
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
  readonly refreshToken?: string | null;
  readonly tokenExpiresAt?: Date | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PatchConnectorMetadataInput {
  readonly tenantId: TenantId;
  readonly provider: ConnectorProvider;
  readonly shopDomain: string;
  /** Shallow-merged on top of the existing metadata blob. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PatchConnectorTokensInput {
  readonly tenantId: TenantId;
  readonly provider: ConnectorProvider;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly tokenExpiresAt: Date | null;
  /** When omitted, the existing refresh token is kept. */
  readonly refreshToken?: string | null;
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

    /**
     * Refresh-token / access-token rotation. Hot path on the Gmail connector
     * — every call after `tokenExpiresAt` lapses goes through here.
     */
    readonly patchTokens: (
      input: PatchConnectorTokensInput,
    ) => Effect.Effect<
      ConnectorConnection,
      ConnectorNotFound | ConnectorStoreDbError
    >;

    /**
     * Shallow-merge the per-connector metadata blob (e.g. Gmail historyId,
     * watch expiry). Atomic single-row UPDATE so concurrent webhook
     * deliveries don't clobber each other.
     */
    readonly patchMetadata: (
      input: PatchConnectorMetadataInput,
    ) => Effect.Effect<
      ConnectorConnection,
      ConnectorNotFound | ConnectorStoreDbError
    >;
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
        const k = key(input.tenantId, input.provider, input.shopDomain);
        const prior = store.get(k);
        const row: ConnectorConnection = {
          tenantId: input.tenantId,
          provider: input.provider,
          shopDomain: input.shopDomain,
          accessToken: input.accessToken,
          refreshToken:
            input.refreshToken !== undefined
              ? input.refreshToken
              : (prior?.refreshToken ?? null),
          tokenExpiresAt:
            input.tokenExpiresAt !== undefined
              ? input.tokenExpiresAt
              : (prior?.tokenExpiresAt ?? null),
          metadata:
            input.metadata !== undefined
              ? { ...(prior?.metadata ?? {}), ...input.metadata }
              : (prior?.metadata ?? {}),
          scopes: input.scopes,
          apiVersion: input.apiVersion ?? null,
          installedAt: prior?.installedAt ?? new Date(),
          status: "active",
        };
        store.set(k, row);
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

    const patchTokens: (
      input: PatchConnectorTokensInput,
    ) => Effect.Effect<
      ConnectorConnection,
      ConnectorNotFound | ConnectorStoreDbError
    > = (input) =>
      Effect.suspend((): Effect.Effect<
        ConnectorConnection,
        ConnectorNotFound | ConnectorStoreDbError
      > => {
        const k = key(input.tenantId, input.provider, input.shopDomain);
        const prior = store.get(k);
        if (!prior) {
          return Effect.fail(
            new ConnectorNotFound({
              tenantId: input.tenantId,
              provider: input.provider,
              shopDomain: input.shopDomain,
            }),
          );
        }
        const next: ConnectorConnection = {
          ...prior,
          accessToken: input.accessToken,
          tokenExpiresAt: input.tokenExpiresAt,
          refreshToken:
            input.refreshToken !== undefined
              ? input.refreshToken
              : prior.refreshToken,
        };
        store.set(k, next);
        return Effect.succeed(next);
      });

    const patchMetadata: (
      input: PatchConnectorMetadataInput,
    ) => Effect.Effect<
      ConnectorConnection,
      ConnectorNotFound | ConnectorStoreDbError
    > = (input) =>
      Effect.suspend((): Effect.Effect<
        ConnectorConnection,
        ConnectorNotFound | ConnectorStoreDbError
      > => {
        const k = key(input.tenantId, input.provider, input.shopDomain);
        const prior = store.get(k);
        if (!prior) {
          return Effect.fail(
            new ConnectorNotFound({
              tenantId: input.tenantId,
              provider: input.provider,
              shopDomain: input.shopDomain,
            }),
          );
        }
        const next: ConnectorConnection = {
          ...prior,
          metadata: { ...prior.metadata, ...input.metadata },
        };
        store.set(k, next);
        return Effect.succeed(next);
      });

    return ConnectorCredentialStore.of({
      put,
      get,
      revoke,
      listForTenant,
      patchTokens,
      patchMetadata,
    });
  });
