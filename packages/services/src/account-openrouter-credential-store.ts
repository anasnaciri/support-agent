import { Context, Effect, Layer } from "effect";
import type { ConnectorStoreDbError } from "@support-agent/agent-core";

export interface AccountOpenRouterCredential {
  readonly organizationId: string;
  readonly apiKey: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: "active" | "revoked";
  readonly installedAt: Date;
  readonly revokedAt: Date | null;
  readonly updatedAt: Date;
}

export interface PutAccountOpenRouterCredentialInput {
  readonly organizationId: string;
  readonly apiKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class AccountOpenRouterCredentialStore extends Context.Tag(
  "AccountOpenRouterCredentialStore",
)<
  AccountOpenRouterCredentialStore,
  {
    readonly put: (
      input: PutAccountOpenRouterCredentialInput,
    ) => Effect.Effect<AccountOpenRouterCredential, ConnectorStoreDbError>;
    readonly get: (
      organizationId: string,
    ) => Effect.Effect<AccountOpenRouterCredential | null, ConnectorStoreDbError>;
    readonly revoke: (
      organizationId: string,
    ) => Effect.Effect<boolean, ConnectorStoreDbError>;
    readonly patchMetadata: (
      organizationId: string,
      metadata: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<AccountOpenRouterCredential | null, ConnectorStoreDbError>;
  }
>() {}

export const AccountOpenRouterCredentialStoreTest = (
  seed: ReadonlyArray<AccountOpenRouterCredential> = [],
) =>
  Layer.sync(AccountOpenRouterCredentialStore, () => {
    const rows = new Map(seed.map((row) => [row.organizationId, row]));
    return AccountOpenRouterCredentialStore.of({
      put: (input) =>
        Effect.sync(() => {
          const prior = rows.get(input.organizationId);
          const now = new Date();
          const row: AccountOpenRouterCredential = {
            organizationId: input.organizationId,
            apiKey: input.apiKey,
            metadata:
              input.metadata !== undefined
                ? { ...(prior?.metadata ?? {}), ...input.metadata }
                : (prior?.metadata ?? {}),
            status: "active",
            installedAt: prior?.installedAt ?? now,
            revokedAt: null,
            updatedAt: now,
          };
          rows.set(input.organizationId, row);
          return row;
        }),
      get: (organizationId) =>
        Effect.sync(() => rows.get(organizationId) ?? null),
      revoke: (organizationId) =>
        Effect.sync(() => {
          const prior = rows.get(organizationId);
          if (!prior) return false;
          const now = new Date();
          rows.set(organizationId, {
            ...prior,
            status: "revoked",
            revokedAt: now,
            updatedAt: now,
          });
          return true;
        }),
      patchMetadata: (organizationId, metadata) =>
        Effect.sync(() => {
          const prior = rows.get(organizationId);
          if (!prior) return null;
          const row = {
            ...prior,
            metadata: { ...prior.metadata, ...metadata },
            updatedAt: new Date(),
          };
          rows.set(organizationId, row);
          return row;
        }),
    });
  });
