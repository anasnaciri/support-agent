import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { auditLog, DbClient, tenants } from "@support-agent/db";
import {
  ShopifyAppProvisioningStore,
  ShopifyService,
  type OrderPiiPresence,
  type ShopifyAppProvisioning,
} from "@support-agent/services";
import {
  TenantId,
  type ConnectorStoreDbError,
  type ShopifyError,
} from "@support-agent/agent-core";
import {
  claimShopifyShopForTenant,
  ShopifyShopAlreadyConnected,
} from "./tenant-resolver.js";

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

/** `put` lands on one of these — it never reports `not_provisioned`. */
export type PutAdminShopifyAppResult =
  | { readonly kind: "ok"; readonly provisioning: AdminShopifyAppView }
  | { readonly kind: "tenant_not_found" }
  | {
      // The requested shop is already actively connected to another tenant
      // (A4) — the operator must offboard it there first.
      readonly kind: "shop_conflict";
      readonly shopDomain: string;
      readonly ownerTenantId: string;
    };

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
  /** Already-normalized `*.myshopify.com` domain, or undefined (A4). */
  readonly shopDomain?: string;
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
    // When the operator names the store up front (A4), bind it to this tenant
    // FIRST — both on tenants.shopify_domain (so a custom-distribution
    // no-state callback resolves the existing tenant instead of auto-creating
    // one) and, below, on the provisioning row. Claiming first means a shop
    // already owned by another tenant aborts before any credential write.
    if (input.shopDomain) {
      const claim = yield* Effect.either(
        claimShopifyShopForTenant(input.shopDomain, input.tenantId),
      );
      if (claim._tag === "Left") {
        if (claim.left instanceof ShopifyShopAlreadyConnected) {
          return {
            kind: "shop_conflict",
            shopDomain: input.shopDomain,
            ownerTenantId: claim.left.ownerTenantId,
          } as const;
        }
        return yield* Effect.fail(claim.left);
      }
    }
    const store = yield* ShopifyAppProvisioningStore;
    const row = yield* store.put({
      tenantId: TenantId(input.tenantId),
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.shopDomain ? { shopDomain: input.shopDomain } : {}),
    });
    yield* writeAudit(input.tenantId, "shopify_app.provisioned", {
      clientId: input.clientId,
      ...(input.shopDomain ? { shopDomain: input.shopDomain } : {}),
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

// ============================================================
// Protected-customer-data (PCD) live check
// ============================================================

/**
 * Aggregated verdict for the per-tenant PCD check. We never surface the
 * actual customer values — only whether the connected store returns the
 * Level-2 PII fields populated or redacted.
 *
 * - `present`  — at least one recent order returned customer email; the
 *   PCD field declaration is working.
 * - `redacted` — orders exist but none returned customer email, which on
 *   a real store almost always means Shopify is redacting protected
 *   customer data because the app hasn't declared its PCD fields.
 * - `no_orders` — the store has no orders yet, so the check is inconclusive.
 */
export interface PcdSummary {
  readonly verdict: "present" | "redacted" | "no_orders";
  readonly ordersChecked: number;
  readonly sawEmail: boolean;
  readonly sawCustomerName: boolean;
  readonly sawShippingAddress: boolean;
}

/**
 * Pure verdict from the per-order presence samples. Email is the anchor
 * signal: essentially every real order carries a customer email, so its
 * absence across the whole recent window is the reliable redaction tell.
 * Name and shipping address can be legitimately missing (guest checkout,
 * digital goods) so they inform the message but don't drive the verdict.
 */
export const summarizeOrderPii = (
  samples: ReadonlyArray<OrderPiiPresence>,
): PcdSummary => {
  if (samples.length === 0) {
    return {
      verdict: "no_orders",
      ordersChecked: 0,
      sawEmail: false,
      sawCustomerName: false,
      sawShippingAddress: false,
    };
  }
  const sawEmail = samples.some((s) => s.hasEmail);
  const sawCustomerName = samples.some((s) => s.hasCustomerName);
  const sawShippingAddress = samples.some((s) => s.hasShippingAddress);
  return {
    verdict: sawEmail ? "present" : "redacted",
    ordersChecked: samples.length,
    sawEmail,
    sawCustomerName,
    sawShippingAddress,
  };
};

export type PcdCheckResult =
  | { readonly kind: "tenant_not_found" }
  | { readonly kind: "not_connected" }
  | ({ readonly kind: "summary" } & PcdSummary);

/** Number of recent orders sampled by the PCD check. */
const PCD_SAMPLE_SIZE = 5;

/**
 * Run the live PCD check for a tenant: read a few recent orders through
 * the tenant's connected Shopify store and report whether protected
 * customer data comes back populated or redacted. `ShopifyAuthMissing`
 * (no live connection / revoked token) maps to `not_connected` — an
 * expected operator state, not an error.
 */
export const checkAdminShopifyAppPcd = (
  tenantId: string,
): Effect.Effect<
  PcdCheckResult,
  Error | ShopifyError,
  DbClient | ShopifyService
> =>
  Effect.gen(function* () {
    if (!(yield* tenantExists(tenantId))) {
      return { kind: "tenant_not_found" } as const;
    }
    const shopify = yield* ShopifyService;
    return yield* shopify
      .listRecentOrderPiiPresence(TenantId(tenantId), PCD_SAMPLE_SIZE)
      .pipe(
        Effect.map(
          (samples): PcdCheckResult => ({
            kind: "summary",
            ...summarizeOrderPii(samples),
          }),
        ),
        Effect.catchTag(
          "ShopifyAuthMissing",
          (): Effect.Effect<PcdCheckResult> =>
            Effect.succeed({ kind: "not_connected" } as const),
        ),
      );
  });
