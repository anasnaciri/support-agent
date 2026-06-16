import { desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  connectionsList,
  connectorConnections,
  DbClient,
  shopifyAppProvisioning,
  tenants,
} from "@support-agent/db";
import {
  AccountOpenRouterCredentialStore,
  ShopifyAppProvisioningStore,
  type ShopifyAppProvisioningStatus,
} from "@support-agent/services";
import {
  TenantId,
  type ConnectorStoreDbError,
} from "@support-agent/agent-core";
import type {
  AdminOpenRouterCredentialView,
  AdminTenantDetail,
  AdminTenantSummary,
} from "@support-agent/dashboard-contracts";

const LLM_PROVIDERS = new Set(["openrouter", "anthropic", "openai"]);

const accountView = (
  row: {
    readonly status: "active" | "revoked";
    readonly installedAt: Date;
    readonly updatedAt: Date;
  } | null,
): AdminOpenRouterCredentialView | null =>
  row
    ? {
        status: row.status,
        installedAt: row.installedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }
    : null;

/** Tenant list for the operator admin app (one row per tenant). */
export const listTenantsForAdmin = (): Effect.Effect<
  ReadonlyArray<AdminTenantSummary>,
  Error,
  DbClient
> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const tenantRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: tenants.id,
            name: tenants.name,
            workosOrganizationId: tenants.workosOrganizationId,
            createdAt: tenants.createdAt,
          })
          .from(tenants)
          .orderBy(desc(tenants.createdAt)),
      catch: (cause) => new Error(`listTenantsForAdmin tenants: ${String(cause)}`),
    });
    const provRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            tenantId: shopifyAppProvisioning.tenantId,
            status: shopifyAppProvisioning.status,
          })
          .from(shopifyAppProvisioning),
      catch: (cause) => new Error(`listTenantsForAdmin provisioning: ${String(cause)}`),
    });
    const countRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            tenantId: connectorConnections.tenantId,
            count: sql<number>`count(*)::int`,
          })
          .from(connectorConnections)
          .groupBy(connectorConnections.tenantId),
      catch: (cause) => new Error(`listTenantsForAdmin counts: ${String(cause)}`),
    });

    const statusByTenant = new Map(
      provRows.map((r) => [r.tenantId, r.status as ShopifyAppProvisioningStatus]),
    );
    const countByTenant = new Map(
      countRows.map((r) => [r.tenantId, Number(r.count)]),
    );

    return tenantRows.map((t): AdminTenantSummary => {
      const status = statusByTenant.get(t.id) ?? null;
      return {
        id: t.id,
        name: t.name,
        workosOrganizationId: t.workosOrganizationId,
        // Resolved from WorkOS by the HTTP handler (the org name lives only in
        // WorkOS, not in our `tenants` rows); null here is the pre-enrichment
        // placeholder and the value when WorkOS isn't configured.
        workosOrganizationName: null,
        createdAt: t.createdAt.toISOString(),
        shopifyApp: {
          provisioned: status !== null && status !== "revoked",
          status,
        },
        connectionCount: countByTenant.get(t.id) ?? 0,
      };
    });
  });

/** Operator detail for one tenant. Returns `null` when the tenant is gone. */
export const getTenantDetailForAdmin = (
  id: string,
): Effect.Effect<
  AdminTenantDetail | null,
  Error | ConnectorStoreDbError,
  DbClient | ShopifyAppProvisioningStore | AccountOpenRouterCredentialStore
> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: tenants.id,
            name: tenants.name,
            workosOrganizationId: tenants.workosOrganizationId,
            shopifyDomain: tenants.shopifyDomain,
            createdAt: tenants.createdAt,
          })
          .from(tenants)
          .where(eq(tenants.id, id))
          .limit(1),
      catch: (cause) => new Error(`getTenantDetailForAdmin tenant: ${String(cause)}`),
    });
    const t = rows[0];
    if (!t) return null;

    const store = yield* ShopifyAppProvisioningStore;
    const prov = yield* store.get(TenantId(id));
    const connections = yield* Effect.tryPromise({
      try: () => connectionsList(db, id),
      catch: (cause) =>
        new Error(`getTenantDetailForAdmin connections: ${String(cause)}`),
    });
    const accountStore = yield* AccountOpenRouterCredentialStore;
    const account = t.workosOrganizationId
      ? yield* accountStore.get(t.workosOrganizationId)
      : null;
    const workspaceLlm =
      connections.find(
        (row) => LLM_PROVIDERS.has(row.provider) && row.status === "active",
      ) ??
      connections.find((row) => LLM_PROVIDERS.has(row.provider)) ??
      null;
    const effectiveSource =
      workspaceLlm?.status === "active"
        ? ("workspace" as const)
        : account?.status === "active"
          ? ("account" as const)
          : null;

    return {
      tenant: {
        id: t.id,
        name: t.name,
        workosOrganizationId: t.workosOrganizationId,
        // Resolved from WorkOS by the HTTP handler; null is the pre-enrichment
        // placeholder / the value when WorkOS isn't configured.
        workosOrganizationName: null,
        shopifyDomain: t.shopifyDomain,
        createdAt: t.createdAt.toISOString(),
      },
      // The secret is intentionally dropped here — only client_id is surfaced.
      shopifyApp: prov
        ? {
            clientId: prov.clientId,
            shopDomain: prov.shopDomain,
            status: prov.status,
            updatedAt: prov.updatedAt.toISOString(),
          }
        : null,
      connections,
      llm: {
        effectiveProvider:
          workspaceLlm?.status === "active"
            ? workspaceLlm.provider
            : account?.status === "active"
              ? "openrouter"
              : null,
        effectiveSource,
        workspaceOverride: workspaceLlm
          ? {
              provider: workspaceLlm.provider,
              status:
                workspaceLlm.status === "active" ? "active" : "revoked",
              updatedAt: workspaceLlm.updatedAt,
            }
          : null,
        accountOpenrouter: accountView(account),
      },
    };
  });
