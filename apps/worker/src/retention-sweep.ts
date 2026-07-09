// ============================================================
// Ticket retention sweep
// ============================================================
//
// Daily cron that stages ticket retention:
//   1. `resolved` tickets older than 30 days are moved to `archived`.
//   2. `archived` tickets older than 12 months are deleted with their
//      cascaded rows.
//
// The deletion uses the same FK ordering as the Shopify compliance
// `customers/redact` webhook (see `apps/api/src/compliance-redaction.ts`):
//   approvals (FK to tickets) → audit_log (no FK cascade) →
//   tickets (CASCADE to ticket_state_transitions)
//
// Per-tenant scoping happens INSIDE each SELECT for matched ticket ids, so a
// misconfigured tenant can't accidentally wipe another tenant's data. The cron
// walks tenants one at a time — sequential rather than concurrent because a
// misbehaving tenant deletion shouldn't slow every other tenant down, and the
// operation is rare enough that total throughput doesn't matter.

import { Effect } from "effect";
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  approvals,
  auditLog,
  ticketAttachments,
  tickets,
  ticketStateTransitions,
  DbClient,
  tenants,
} from "@support-agent/db";
import { BlobStorage } from "@support-agent/services";

export const RESOLVED_CASE_ARCHIVE_AFTER_DAYS = 30;
export const ARCHIVED_CASE_DELETE_AFTER_MONTHS = 12;

export interface SweepTenantResult {
  readonly kind: "ok";
  readonly tenantId: string;
  readonly archiveCutoff: Date;
  readonly deleteCutoff: Date;
  readonly archivedTickets: number;
  readonly deletedTickets: number;
  readonly deletedAuditRows: number;
  readonly deletedApprovals: number;
  /**
   * Blob keys of the deleted tickets' attachments. `ticket_attachments` rows
   * cascade away with the ticket, taking the only pointer to the object with
   * them — so the keys are captured inside the transaction and the caller
   * deletes the blobs after it commits.
   */
  readonly deletedAttachmentKeys: ReadonlyArray<string>;
}

export interface SweepTenantFailure {
  readonly kind: "failed";
  readonly tenantId: string;
  readonly error: string;
}

export type SweepResult = SweepTenantResult | SweepTenantFailure;

/**
 * Compute the cutoff timestamp for archiving resolved tickets. Pure — exported
 * so the cron schedule + tests share the same calc.
 */
export const computeResolvedArchiveCutoff = (now: Date): Date =>
  new Date(
    now.getTime() - RESOLVED_CASE_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

const utcDaysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const subtractUtcMonths = (now: Date, months: number): Date => {
  const targetMonthIndex = now.getUTCMonth() - months;
  const firstOfTarget = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      targetMonthIndex,
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
  const day = Math.min(
    now.getUTCDate(),
    utcDaysInMonth(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth()),
  );
  firstOfTarget.setUTCDate(day);
  return firstOfTarget;
};

/** Compute the cutoff timestamp for deleting archived tickets. */
export const computeArchivedDeleteCutoff = (now: Date): Date =>
  subtractUtcMonths(now, ARCHIVED_CASE_DELETE_AFTER_MONTHS);

/**
 * Archive resolved tickets past the 30-day window, then delete archived tickets
 * past the 12-month window. Returns counts so the cron can log them. Skips
 * tickets that aren't `resolved`/`archived` — `human_takeover` / `failed` stay
 * parked unless a separate explicit deletion/redaction path handles them.
 */
export const sweepTenant = (
  tenantId: string,
  now: Date,
): Effect.Effect<SweepTenantResult, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const archiveCutoff = computeResolvedArchiveCutoff(now);
    const deleteCutoff = computeArchivedDeleteCutoff(now);
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // 1. Archive resolved tickets in the mutation itself. The status +
          // cutoff predicates are repeated here so a ticket that reopens while
          // the sweep waits on its row lock is not force-archived.
          const archivedRows = await tx
            .update(tickets)
            .set({ status: "archived", updatedAt: now, archivedAt: now })
            .where(
              and(
                eq(tickets.tenantId, tenantId),
                eq(tickets.status, "resolved"),
                lt(tickets.resolvedAt, archiveCutoff),
              ),
            )
            .returning({ id: tickets.id });
          const archiveIds = archivedRows.map((r) => r.id);
          if (archiveIds.length > 0) {
            await tx.insert(ticketStateTransitions).values(
              archiveIds.map((ticketId) => ({
                ticketId,
                fromStatus: "resolved",
                toStatus: "archived",
                reason: "retention archive after 30 days resolved",
              })),
            );
            await tx.insert(auditLog).values(
              archiveIds.map((ticketId) => ({
                tenantId,
                ticketId,
                actorType: "system",
                actorId: "retention-sweep",
                action: "ticket.archived",
                details: {
                  archiveCutoff: archiveCutoff.toISOString(),
                  archivedAt: now.toISOString(),
                },
              })),
            );
          }

          // 2. Lock archived tickets before deleting dependent rows. With
          // READ COMMITTED, SELECT ... FOR UPDATE rechecks the predicate after
          // a concurrent reopen commits, so live tickets keep their audit trail.
          const deleteMatched = await tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(
              and(
                eq(tickets.tenantId, tenantId),
                eq(tickets.status, "archived"),
                lt(tickets.archivedAt, deleteCutoff),
              ),
            )
            .for("update");
          const deleteIds = deleteMatched.map((r) => r.id);
          if (deleteIds.length === 0) {
            return {
              kind: "ok",
              tenantId,
              archiveCutoff,
              deleteCutoff,
              archivedTickets: archiveIds.length,
              deletedTickets: 0,
              deletedAuditRows: 0,
              deletedApprovals: 0,
              deletedAttachmentKeys: [],
            } satisfies SweepTenantResult;
          }

          // Capture attachment blob keys BEFORE the ticket delete cascades
          // their index rows away — afterwards nothing points at the objects.
          const attachmentRows = await tx
            .select({ storageKey: ticketAttachments.storageKey })
            .from(ticketAttachments)
            .where(
              and(
                eq(ticketAttachments.tenantId, tenantId),
                inArray(ticketAttachments.ticketId, deleteIds),
              ),
            );

          // 3. Cascaded delete in FK-safe order.
          const deletedApprovals = await tx
            .delete(approvals)
            .where(inArray(approvals.ticketId, deleteIds))
            .returning({ id: approvals.id });
          const deletedAudit = await tx
            .delete(auditLog)
            .where(inArray(auditLog.ticketId, deleteIds))
            .returning({ id: auditLog.id });
          const deletedTickets = await tx
            .delete(tickets)
            .where(
              and(
                inArray(tickets.id, deleteIds),
                eq(tickets.tenantId, tenantId),
                eq(tickets.status, "archived"),
                lt(tickets.archivedAt, deleteCutoff),
              ),
            )
            .returning({ id: tickets.id });

          return {
            kind: "ok",
            tenantId,
            archiveCutoff,
            deleteCutoff,
            archivedTickets: archiveIds.length,
            deletedTickets: deletedTickets.length,
            deletedAuditRows: deletedAudit.length,
            deletedApprovals: deletedApprovals.length,
            deletedAttachmentKeys: attachmentRows.map((r) => r.storageKey),
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
 *
 * Attachment blobs of deleted tickets are removed AFTER the tenant's
 * transaction commits: a failed blob delete must not roll back a completed
 * retention deletion. A leaked blob is logged and otherwise harmless — nothing
 * references it, and it is no longer reachable through any ticket.
 */
export const sweepAllTenants = (
  opts: SweepAllTenantsOptions = {},
): Effect.Effect<ReadonlyArray<SweepResult>, never, DbClient | BlobStorage> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const blob = yield* BlobStorage;
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
      const result = yield* sweepTenant(tenantId, now).pipe(
        Effect.either,
      );
      if (result._tag === "Right") {
        for (const key of result.right.deletedAttachmentKeys) {
          const removed = yield* blob.delete(key).pipe(Effect.either);
          if (removed._tag === "Left") {
            // eslint-disable-next-line no-console
            console.warn(
              `[retention-sweep] tenant=${tenantId} blob delete failed for ${key}: ${String(removed.left)}`,
            );
          }
        }
        out.push(result.right);
      } else {
        out.push({ kind: "failed", tenantId, error: result.left.message });
      }
    }
    return out;
  });
