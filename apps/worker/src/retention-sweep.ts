// ============================================================
// Resolved-case retention sweep
// ============================================================
//
// Daily cron that deletes resolved cases (and their cascaded rows)
// past each tenant's configured retention window. Required for the
// privacy-policy commitment in `docs/shopify-pcd.md` §7 — "personal
// data isn't kept longer than needed" — and unlocks onboarding paying
// merchants subject to GDPR/CCPA-style minimum-retention rules.
//
// The deletion uses the same FK ordering as the Shopify compliance
// `customers/redact` webhook (see `apps/api/src/compliance-redaction.ts`):
//   approvals (FK to cases) → audit_log (no FK cascade) →
//   cases (CASCADE to case_state_transitions)
//
// Per-tenant scoping happens INSIDE the SELECT for matched case ids,
// so a misconfigured tenant can't accidentally wipe another tenant's
// data. The cron walks tenants one at a time — sequential rather than
// concurrent because a misbehaving tenant deletion shouldn't slow
// every other tenant down, and the operation is rare enough that
// total throughput doesn't matter.

import { Effect } from "effect";
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  approvals,
  auditLog,
  cases,
  DbClient,
  tenants,
} from "@support-agent/db";
import {
  DEFAULT_RETENTION_DAYS,
  TenantRepository,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";

export interface SweepTenantResult {
  readonly kind: "ok";
  readonly tenantId: string;
  readonly retentionDays: number;
  readonly cutoff: Date;
  readonly deletedCases: number;
  readonly deletedAuditRows: number;
  readonly deletedApprovals: number;
}

export interface SweepTenantFailure {
  readonly kind: "failed";
  readonly tenantId: string;
  readonly error: string;
}

export type SweepResult = SweepTenantResult | SweepTenantFailure;

/**
 * Compute the cutoff timestamp from a reference time and a retention
 * window in days. Pure — exported so the cron schedule + tests share
 * the same calc. `retentionDays` MUST be a positive integer; the caller
 * (or the TenantRepository decode) already enforces this.
 */
export const computeCutoff = (now: Date, retentionDays: number): Date =>
  new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

/**
 * Delete every resolved case for one tenant whose `resolved_at` is
 * older than the cutoff. Returns counts so the cron can log them.
 * Skips cases that aren't `resolved` — `human_takeover` / `failed`
 * stay forever (today; we may add separate retention for those later).
 */
export const sweepTenant = (
  tenantId: string,
  retentionDays: number,
  now: Date,
): Effect.Effect<SweepTenantResult, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const cutoff = computeCutoff(now, retentionDays);
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // 1. find the cases to purge — scoped to this tenant only.
          const matched = await tx
            .select({ id: cases.id })
            .from(cases)
            .where(
              and(
                eq(cases.tenantId, tenantId),
                eq(cases.status, "resolved"),
                lt(cases.resolvedAt, cutoff),
              ),
            );
          const ids = matched.map((r) => r.id);
          if (ids.length === 0) {
            return {
              kind: "ok",
              tenantId,
              retentionDays,
              cutoff,
              deletedCases: 0,
              deletedAuditRows: 0,
              deletedApprovals: 0,
            } satisfies SweepTenantResult;
          }

          // 2. cascaded delete in FK-safe order.
          const deletedApprovals = await tx
            .delete(approvals)
            .where(inArray(approvals.caseId, ids))
            .returning({ id: approvals.id });
          const deletedAudit = await tx
            .delete(auditLog)
            .where(inArray(auditLog.caseId, ids))
            .returning({ id: auditLog.id });
          const deletedCases = await tx
            .delete(cases)
            .where(inArray(cases.id, ids))
            .returning({ id: cases.id });

          return {
            kind: "ok",
            tenantId,
            retentionDays,
            cutoff,
            deletedCases: deletedCases.length,
            deletedAuditRows: deletedAudit.length,
            deletedApprovals: deletedApprovals.length,
          } satisfies SweepTenantResult;
        }),
      catch: (cause) =>
        new Error(`sweepTenant(${tenantId}) failed: ${String(cause)}`),
    });
  });

export interface SweepAllTenantsOptions {
  /** Overrideable for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Walk every tenant row and sweep each one. Per-tenant failures are
 * isolated via `Effect.either` so a single broken tenant can't poison
 * the pass — the cron logs the error and continues. Returns the per-
 * tenant outcomes for the caller to summarise into logs / metrics.
 */
export const sweepAllTenants = (
  opts: SweepAllTenantsOptions = {},
): Effect.Effect<ReadonlyArray<SweepResult>, never, DbClient | TenantRepository> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const repo = yield* TenantRepository;
    const now = (opts.now ?? (() => new Date()))();

    // Stream tenants — even a few thousand rows is fine to fetch in one
    // shot. If we ever cross that, switch to a paginated cursor.
    const rows = yield* Effect.tryPromise({
      try: () => db.select({ id: tenants.id }).from(tenants),
      catch: (cause) => new Error(`list tenants failed: ${String(cause)}`),
    }).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          // eslint-disable-next-line no-console
          console.error(`[retention-sweep] tenant list failed: ${e.message}`);
          return [] as ReadonlyArray<{ readonly id: string }>;
        }),
      ),
    );

    const out: Array<SweepResult> = [];
    for (const row of rows) {
      const tenantId = row.id;
      const settings = yield* repo.getSettings(TenantId(tenantId)).pipe(
        Effect.either,
      );
      const retentionDays =
        settings._tag === "Right"
          ? settings.right.retentionDays
          : DEFAULT_RETENTION_DAYS;
      const result = yield* sweepTenant(tenantId, retentionDays, now).pipe(
        Effect.either,
      );
      if (result._tag === "Right") {
        out.push(result.right);
      } else {
        out.push({ kind: "failed", tenantId, error: result.left.message });
      }
    }
    return out;
  });
