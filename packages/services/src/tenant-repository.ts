import { Context, Data, Effect, Layer } from "effect";
import type { TenantId } from "@support-agent/agent-core";

// ============================================================
// TenantRepository
// ============================================================
//
// Read access to the `tenants` table. Today the only field anyone
// needs through the Tag is the operator's notification email (where
// approval-link mail goes); the interface stays narrow so adding new
// columns doesn't ripple. When the dashboard lands and tenants gain a
// full settings UI, we widen this in one place — `db/...-live` follows.
//
// Why a separate Tag (not just DbClient + drizzle inline): the
// PlatformMailServiceLive lives in `providers`, and CLAUDE.md keeps
// `providers` free of Postgres/db dependencies. Tags in services let
// `providers` consume tenant data without crossing the layer rule.

/**
 * Per-tenant policy for the `refund.create` tool. Thresholds are stored
 * in minor units (cents, pence, ...) so the comparison is integer-clean
 * regardless of decimal formatting. `currencyCode` declares the currency
 * the thresholds apply to; refunds in another currency fall back to
 * `ask` defensively (a future widen can support per-currency thresholds).
 *
 * Zones:
 *   - amountMinorUnits ≤ askAboveMinorUnits        → allow (agent auto-runs)
 *   - askAboveMinorUnits < amountMinorUnits ≤ denyAboveMinorUnits → ask
 *   - amountMinorUnits > denyAboveMinorUnits       → deny (escalate)
 *
 * Defaults are conservative — see `defaultRefundPolicy` below.
 */
export interface RefundPolicy {
  readonly askAboveMinorUnits: number;
  readonly denyAboveMinorUnits: number;
  readonly currencyCode: string;
}

/**
 * Hard fallback used when a tenant has never configured a refund policy.
 * Picks ISO USD and a conservative $0 ask threshold so every refund is
 * gated by default — operators must explicitly raise the threshold to
 * give the agent autonomy. Better to over-ask on day 1 than auto-refund
 * something the merchant didn't intend.
 */
export const defaultRefundPolicy: RefundPolicy = {
  askAboveMinorUnits: 0,
  denyAboveMinorUnits: 50_000, // $500 hard cap
  currencyCode: "USD",
};

/**
 * Default retention for resolved cases. 24 months from `resolved_at`
 * matches the privacy-policy default in `docs/shopify-pcd.md` §7. The
 * retention sweep cron deletes resolved cases (and their cascaded
 * `case_state_transitions` / `audit_log` rows) past this window.
 *
 * Merchants can shorten this per-tenant via the dashboard; we don't let
 * them lengthen it past the platform-wide regulatory ceiling (today the
 * dashboard form caps at this default).
 */
export const DEFAULT_RETENTION_DAYS = 730;

export class TenantSettings extends Data.Class<{
  /** Email the platform sends approval / system mail to. */
  readonly notificationEmail: string | null;
  /**
   * Conditional thresholds for `refund.create`. Configurable per-tenant
   * via the dashboard `/settings/refund-policy` page. Always populated —
   * we fall back to `defaultRefundPolicy` when the JSONB column has no
   * matching block (or has malformed values).
   */
  readonly refundPolicy: RefundPolicy;
  /**
   * Days of retention for resolved cases (counted from `resolved_at`).
   * The retention sweep cron deletes anything older. Defaults to
   * `DEFAULT_RETENTION_DAYS` when the tenant has no value set.
   */
  readonly retentionDays: number;
}> {}

export class TenantNotFound extends Data.TaggedError("TenantNotFound")<{
  readonly tenantId: TenantId;
}> {}

export class TenantRepositoryDbError extends Data.TaggedError(
  "TenantRepositoryDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type TenantRepositoryError = TenantNotFound | TenantRepositoryDbError;

export class TenantRepository extends Context.Tag("TenantRepository")<
  TenantRepository,
  {
    readonly getSettings: (
      tenantId: TenantId,
    ) => Effect.Effect<TenantSettings, TenantRepositoryError>;
    /**
     * Replace the tenant's refund policy. Writes the new block into the
     * `tenants.settings` JSONB column without touching unrelated fields
     * (deep-merge semantics enforced by the Live impl).
     */
    readonly setRefundPolicy: (
      tenantId: TenantId,
      policy: RefundPolicy,
    ) => Effect.Effect<void, TenantRepositoryError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface TenantRepositoryTestFixtures {
  readonly settingsByTenant?: ReadonlyMap<TenantId, TenantSettings>;
}

export const TenantRepositoryTest = (
  fixtures: TenantRepositoryTestFixtures = {},
): Layer.Layer<TenantRepository> => {
  // Mutable copy so setRefundPolicy is observable in tests.
  const store = new Map<TenantId, TenantSettings>(
    fixtures.settingsByTenant
      ? Array.from(fixtures.settingsByTenant.entries())
      : [],
  );
  return Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: (tenantId) => {
        const hit = store.get(tenantId);
        return hit
          ? Effect.succeed(hit)
          : Effect.fail(new TenantNotFound({ tenantId }));
      },
      setRefundPolicy: (tenantId, policy) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({
            notificationEmail: prev.notificationEmail,
            refundPolicy: policy,
            retentionDays: prev.retentionDays,
          }),
        );
        return Effect.void;
      },
    }),
  );
};
