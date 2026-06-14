import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Effect, FiberRef } from "effect";
import {
  AccountOpenRouterCredentialStore,
  ConnectorCredentialStore,
  TenantRepository,
  legalAcceptanceIsCurrent,
  type AccountOpenRouterCredential,
  type LLMProvider,
} from "@support-agent/services";
import { TenantId, type ConnectorStoreDbError } from "@support-agent/agent-core";
import {
  CurrentTxRef,
  DbClient,
  adminAuditLog,
  tenants,
  withTransaction,
  type DrizzleDb,
} from "@support-agent/db";
import type {
  AdminAccountDetail,
  AdminOpenRouterCredentialView,
} from "@support-agent/dashboard-contracts";

const LLM_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter",
  "anthropic",
  "openai",
]);

export type AdminOpenRouterMutationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "legal_acceptance_required" };

const present = (
  row: AccountOpenRouterCredential | null,
): AdminOpenRouterCredentialView | null =>
  row
    ? {
        status: row.status,
        installedAt: row.installedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }
    : null;

const useDb = (): Effect.Effect<DrizzleDb, never, DbClient> =>
  FiberRef.get(CurrentTxRef).pipe(
    Effect.flatMap((tx) => (tx ? Effect.succeed(tx) : DbClient)),
  );

const writeAudit = (
  targetTenantId: string,
  action: string,
  details: Readonly<Record<string, unknown>>,
): Effect.Effect<void, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* useDb();
    yield* Effect.tryPromise({
      try: () =>
        db.insert(adminAuditLog).values({
          action,
          targetTenantId,
          actor: "admin",
          details: {
            ...details,
            at: new Date().toISOString(),
            traceId: randomUUID(),
          },
        }),
      catch: (cause) => new Error(`admin audit write failed: ${String(cause)}`),
    });
  });

const orgWorkspaces = (
  organizationId: string,
): Effect.Effect<
  ReadonlyArray<{ readonly id: string; readonly name: string; readonly createdAt: Date }>,
  Error,
  DbClient
> =>
  Effect.gen(function* () {
    const db = yield* useDb();
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt })
          .from(tenants)
          .where(eq(tenants.workosOrganizationId, organizationId))
          .orderBy(asc(tenants.createdAt), asc(tenants.id)),
      catch: (cause) => new Error(`account workspace lookup failed: ${String(cause)}`),
    });
  });

const workspace = (
  tenantId: string,
): Effect.Effect<
  { readonly id: string; readonly organizationId: string | null } | null,
  Error,
  DbClient
> =>
  Effect.gen(function* () {
    const db = yield* useDb();
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id, organizationId: tenants.workosOrganizationId })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      catch: (cause) => new Error(`workspace lookup failed: ${String(cause)}`),
    });
    return rows[0] ?? null;
  });

const legalCurrentForAll = (
  tenantIds: ReadonlyArray<string>,
): Effect.Effect<boolean, never, TenantRepository> =>
  Effect.gen(function* () {
    const repo = yield* TenantRepository;
    for (const id of tenantIds) {
      const current = yield* repo
        .getSettings(TenantId(id))
        .pipe(
          Effect.map((settings) =>
            legalAcceptanceIsCurrent(settings.legalAcceptance),
          ),
          Effect.catchAll(() => Effect.succeed(false)),
        );
      if (!current) return false;
    }
    return true;
  });

export const getAdminAccountDetail = (
  organizationId: string,
): Effect.Effect<
  AdminAccountDetail | null,
  Error | ConnectorStoreDbError,
  DbClient | AccountOpenRouterCredentialStore
> =>
  Effect.gen(function* () {
    const workspaces = yield* orgWorkspaces(organizationId);
    if (workspaces.length === 0) return null;
    const store = yield* AccountOpenRouterCredentialStore;
    const credential = yield* store.get(organizationId);
    return {
      organizationId,
      workspaces: workspaces.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      })),
      openrouter: present(credential),
    };
  });

export const putAdminAccountOpenRouter = (
  organizationId: string,
  apiKey: string,
): Effect.Effect<
  AdminOpenRouterMutationResult,
  Error | ConnectorStoreDbError,
  DbClient | AccountOpenRouterCredentialStore | TenantRepository
> =>
  Effect.gen(function* () {
    const workspaces = yield* orgWorkspaces(organizationId);
    if (workspaces.length === 0) return { kind: "not_found" } as const;
    if (!(yield* legalCurrentForAll(workspaces.map((row) => row.id)))) {
      return { kind: "legal_acceptance_required" } as const;
    }
    return yield* withTransaction(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        yield* store.put({ organizationId, apiKey });
        yield* writeAudit(workspaces[0]!.id, "openrouter.account_set", {
          organizationId,
          workspaceCount: workspaces.length,
        });
        return { kind: "ok" } as const;
      }),
    );
  });

export const revokeAdminAccountOpenRouter = (
  organizationId: string,
): Effect.Effect<
  AdminOpenRouterMutationResult,
  Error | ConnectorStoreDbError,
  DbClient | AccountOpenRouterCredentialStore
> =>
  Effect.gen(function* () {
    const workspaces = yield* orgWorkspaces(organizationId);
    if (workspaces.length === 0) return { kind: "not_found" } as const;
    return yield* withTransaction(
      Effect.gen(function* () {
        const store = yield* AccountOpenRouterCredentialStore;
        if (!(yield* store.revoke(organizationId))) {
          return { kind: "not_configured" } as const;
        }
        yield* writeAudit(workspaces[0]!.id, "openrouter.account_revoked", {
          organizationId,
          workspaceCount: workspaces.length,
        });
        return { kind: "ok" } as const;
      }),
    );
  });

export const putAdminWorkspaceOpenRouter = (
  tenantId: string,
  apiKey: string,
): Effect.Effect<
  AdminOpenRouterMutationResult,
  Error | ConnectorStoreDbError,
  DbClient | ConnectorCredentialStore | TenantRepository
> =>
  Effect.gen(function* () {
    const found = yield* workspace(tenantId);
    if (!found) return { kind: "not_found" } as const;
    if (!(yield* legalCurrentForAll([tenantId]))) {
      return { kind: "legal_acceptance_required" } as const;
    }
    return yield* withTransaction(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(TenantId(tenantId));
        const active = rows.filter(
          (row) => LLM_PROVIDERS.has(row.provider) && row.status === "active",
        );
        yield* Effect.all(
          active.map((row) =>
            store.revoke(
              TenantId(tenantId),
              row.provider as LLMProvider,
              row.shopDomain,
            ),
          ),
          { concurrency: 1 },
        );
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "openrouter",
          shopDomain: "default",
          accessToken: apiKey,
          scopes: [],
        });
        yield* writeAudit(tenantId, "openrouter.workspace_set", {
          organizationId: found.organizationId,
          replacedProviders: active.map((row) => row.provider),
        });
        return { kind: "ok" } as const;
      }),
    );
  });

export const revokeAdminWorkspaceOpenRouter = (
  tenantId: string,
): Effect.Effect<
  AdminOpenRouterMutationResult,
  Error | ConnectorStoreDbError,
  DbClient | ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const found = yield* workspace(tenantId);
    if (!found) return { kind: "not_found" } as const;
    return yield* withTransaction(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(TenantId(tenantId));
        const active = rows.filter(
          (row) => LLM_PROVIDERS.has(row.provider) && row.status === "active",
        );
        if (active.length === 0) return { kind: "not_configured" } as const;
        yield* Effect.all(
          active.map((row) =>
            store.revoke(
              TenantId(tenantId),
              row.provider as LLMProvider,
              row.shopDomain,
            ),
          ),
          { concurrency: 1 },
        );
        yield* writeAudit(tenantId, "openrouter.workspace_revoked", {
          organizationId: found.organizationId,
          revokedProviders: active.map((row) => row.provider),
        });
        return { kind: "ok" } as const;
      }),
    );
  });
