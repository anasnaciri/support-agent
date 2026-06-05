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
  ShopifyAppProvisioningStore,
  type ShopifyAppProvisioningStatus,
} from "@support-agent/services";
import {
  TenantId,
  type ConnectorStoreDbError,
} from "@support-agent/agent-core";
import type {
  AdminTenantDetail,
  AdminTenantSummary,
} from "@support-agent/dashboard-contracts";

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
  DbClient | ShopifyAppProvisioningStore
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

    return {
      tenant: {
        id: t.id,
        name: t.name,
        workosOrganizationId: t.workosOrganizationId,
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
    };
  });
