import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { auditLog, DbClient, tenants } from "@support-agent/db";
import {
  ShopifyAppProvisioningStore,
  type ShopifyAppProvisioning,
} from "@support-agent/services";
import { TenantId, type ConnectorStoreDbError } from "@support-agent/agent-core";

/**
 * Operator-facing view of a tenant's Shopify app provisioning. The
 * `client_secret` is NEVER included — the secret only ever leaves the store
 * to verify webhooks / run OAuth, never over an API response.
 */
export interface AdminShopifyAppView {
  readonly tenantId: string;
  readonly clientId: string;
  readonly shopDomain: string | null;
  readonly status: ShopifyAppProvisioning["status"];
  readonly updatedAt: string;
}

export type AdminShopifyAppResult =
  | { readonly kind: "ok"; readonly provisioning: AdminShopifyAppView }
  | { readonly kind: "tenant_not_found" }
  | { readonly kind: "not_provisioned" };

/** `put` can only ever land on these two — it never reports `not_provisioned`. */
export type PutAdminShopifyAppResult =
  | { readonly kind: "ok"; readonly provisioning: AdminShopifyAppView }
  | { readonly kind: "tenant_not_found" };

const present = (row: ShopifyAppProvisioning): AdminShopifyAppView => ({
  tenantId: row.tenantId,
  clientId: row.clientId,
  shopDomain: row.shopDomain,
  status: row.status,
  updatedAt: row.updatedAt.toISOString(),
});

const tenantExists = (
  tenantId: string,
): Effect.Effect<boolean, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1),
      catch: (cause) => new Error(`tenantExists failed: ${String(cause)}`),
    });
    return rows.length > 0;
  });

const writeAudit = (
  tenantId: string,
  action: string,
  details: Record<string, unknown>,
): Effect.Effect<void, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    yield* Effect.tryPromise({
      try: () =>
        db.insert(auditLog).values({
          tenantId,
          caseId: null,
          actorType: "system",
          actorId: "admin",
          action,
          details: {
            ...details,
            at: new Date().toISOString(),
            traceId: randomUUID(),
          },
        }),
      catch: (cause) => new Error(`audit write failed: ${String(cause)}`),
    });
  });

export interface PutAdminShopifyAppInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Provision (or rotate) a tenant's Shopify custom-app credentials. */
export const putAdminShopifyApp = (
  input: PutAdminShopifyAppInput,
): Effect.Effect<
  PutAdminShopifyAppResult,
  Error | ConnectorStoreDbError,
  DbClient | ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    if (!(yield* tenantExists(input.tenantId))) {
      return { kind: "tenant_not_found" } as const;
    }
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.put({
      tenantId: TenantId(input.tenantId),
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    yield* writeAudit(input.tenantId, "shopify_app.provisioned", {
      clientId: input.clientId,
    });
    return { kind: "ok", provisioning: present(row) } as const;
  });

/** Read a tenant's provisioning status (no secret). */
export const getAdminShopifyApp = (
  tenantId: string,
): Effect.Effect<
  AdminShopifyAppResult,
  Error | ConnectorStoreDbError,
  DbClient | ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    if (!(yield* tenantExists(tenantId))) {
      return { kind: "tenant_not_found" } as const;
    }
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.get(TenantId(tenantId));
    if (!row) return { kind: "not_provisioned" } as const;
    return { kind: "ok", provisioning: present(row) } as const;
  });

/** Revoke a tenant's provisioning (offboarding). */
export const revokeAdminShopifyApp = (
  tenantId: string,
): Effect.Effect<
  AdminShopifyAppResult,
  Error | ConnectorStoreDbError,
  DbClient | ShopifyAppProvisioningStore
> =>
  Effect.gen(function* () {
    if (!(yield* tenantExists(tenantId))) {
      return { kind: "tenant_not_found" } as const;
    }
    const store = yield* ShopifyAppProvisioningStore;
    const existing = yield* store.get(TenantId(tenantId));
    if (!existing) return { kind: "not_provisioned" } as const;
    yield* store.revoke(TenantId(tenantId));
    yield* writeAudit(tenantId, "shopify_app.revoked", {});
    return {
      kind: "ok",
      provisioning: present({ ...existing, status: "revoked" }),
    } as const;
  });
