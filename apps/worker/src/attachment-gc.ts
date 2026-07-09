// ============================================================
// Orphaned attachment GC
// ============================================================
//
// Uploads index themselves on the ticket the moment the bytes land — before
// anyone decides to send them. So a merchant who stages a chip and removes it,
// or a supplier who uploads a file and abandons the update form, leaves a blob
// and an index row that nothing will ever reference again.
//
// A row is "used" once it becomes part of something durable: attached to an
// outgoing customer reply (`resolveDraftAttachmentIds` / the manual reply
// handler) or bound into a supplier's posted update (`recordSupplierUpdate`).
// `used_at` records that. The orphans are what stays NULL.
//
// Two guards keep the sweep off files that are merely WAITING to be used:
//   - a pending approval on the ticket may hold `attachmentIds` in its
//     proposedInput; the tool body only runs (and only marks them) on approve,
//     and approval links live for 30 days.
//   - an OPEN supplier escalation may still receive the update that binds its
//     uploads.
// Both are cheap NOT EXISTS predicates and both fail SAFE (retain, don't
// delete). Inbound (customer) attachments are never swept: the message they
// arrived on is their durable reference.
//
// Blobs go first, rows second, and only for keys whose blob actually went
// away. A crash between the two leaves an unreferenced row whose blob is gone
// — the next pass re-deletes it idempotently and reclaims the row. The reverse
// order would leak the blob forever with no row left pointing at it.

import { Effect } from "effect";
import { and, eq, inArray, isNull, lt, ne, notExists, sql } from "drizzle-orm";
import {
  approvals,
  ticketAttachments,
  ticketSupplierEscalations,
  tenants,
  DbClient,
} from "@support-agent/db";
import { BlobStorage } from "@support-agent/services";

/**
 * How long an unused upload is kept before it is treated as abandoned. Longer
 * than the 30-day approval-link TTL would be redundant (the pending-approval
 * guard already covers a live draft); shorter risks reclaiming a file a
 * merchant staged today and will approve tomorrow.
 */
export const ORPHAN_UPLOAD_AFTER_DAYS = 30;

export const computeOrphanUploadCutoff = (now: Date): Date =>
  new Date(now.getTime() - ORPHAN_UPLOAD_AFTER_DAYS * 24 * 60 * 60 * 1000);

export interface OrphanAttachment {
  readonly id: string;
  readonly storageKey: string;
}

export interface AttachmentGcResult {
  readonly tenantId: string;
  readonly cutoff: Date;
  /** Rows whose blob was deleted and whose index row was then removed. */
  readonly reclaimed: number;
  /** Orphans whose blob delete failed; retried on the next pass. */
  readonly failed: number;
}

/**
 * Orphan candidates for one tenant. Exported for the integration test — the
 * predicate is the whole design, so it is worth asserting directly.
 */
export const findOrphanAttachments = (
  tenantId: string,
  cutoff: Date,
): Effect.Effect<ReadonlyArray<OrphanAttachment>, Error, DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: ticketAttachments.id,
            storageKey: ticketAttachments.storageKey,
          })
          .from(ticketAttachments)
          .where(
            and(
              eq(ticketAttachments.tenantId, tenantId),
              // Inbound customer files belong to their message, not to a draft.
              ne(ticketAttachments.source, "inbound"),
              isNull(ticketAttachments.usedAt),
              lt(ticketAttachments.createdAt, cutoff),
              // A pending approval on this ticket may still name this file in
              // its proposedInput; approving it is what marks the row used.
              // `notExists()` qualifies the correlated columns — a hand-rolled
              // sql`NOT EXISTS(...)` does not, and silently compares the wrong
              // ones (see dashboard-reads.ts).
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(approvals)
                  .where(
                    and(
                      eq(approvals.ticketId, ticketAttachments.ticketId),
                      eq(approvals.tenantId, ticketAttachments.tenantId),
                      eq(approvals.status, "pending"),
                    ),
                  ),
              ),
              // An open escalation can still receive the update that binds its
              // uploads. Merchant rows have a null escalationId, so the
              // subquery matches nothing and the guard passes for them.
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(ticketSupplierEscalations)
                  .where(
                    and(
                      eq(
                        ticketSupplierEscalations.id,
                        ticketAttachments.escalationId,
                      ),
                      eq(ticketSupplierEscalations.status, "open"),
                    ),
                  ),
              ),
            ),
          ),
      catch: (cause) =>
        new Error(`findOrphanAttachments(${tenantId}) failed: ${String(cause)}`),
    });
  });

/**
 * Reclaim one tenant's orphaned uploads: delete each blob, then drop the index
 * rows whose blob is gone. A blob whose delete fails keeps its row, so the
 * next pass sees the same orphan rather than losing track of the object.
 */
export const gcTenantAttachments = (
  tenantId: string,
  now: Date,
): Effect.Effect<AttachmentGcResult, Error, DbClient | BlobStorage> =>
  Effect.gen(function* () {
    const cutoff = computeOrphanUploadCutoff(now);
    const orphans = yield* findOrphanAttachments(tenantId, cutoff);
    if (orphans.length === 0) {
      return { tenantId, cutoff, reclaimed: 0, failed: 0 };
    }

    const blob = yield* BlobStorage;
    const deletable: string[] = [];
    let failed = 0;
    for (const orphan of orphans) {
      const outcome = yield* blob.delete(orphan.storageKey).pipe(Effect.either);
      if (outcome._tag === "Right") {
        deletable.push(orphan.id);
      } else {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[attachment-gc] tenant=${tenantId} blob delete failed for ${orphan.id}: ${String(outcome.left)}`,
        );
      }
    }

    if (deletable.length === 0) {
      return { tenantId, cutoff, reclaimed: 0, failed };
    }

    const db = yield* DbClient;
    const removed = yield* Effect.tryPromise({
      try: () =>
        db
          .delete(ticketAttachments)
          .where(
            and(
              eq(ticketAttachments.tenantId, tenantId),
              inArray(ticketAttachments.id, deletable),
              // Re-check under the delete: a reply sent between the SELECT and
              // here marked the row used, and its blob is already gone. Losing
              // the row would be worse than losing the blob — the send that
              // marked it has the bytes in flight, and any later retry fails
              // loudly (ConversationSendFailed) instead of silently omitting.
              isNull(ticketAttachments.usedAt),
            ),
          )
          .returning({ id: ticketAttachments.id }),
      catch: (cause) =>
        new Error(`gcTenantAttachments(${tenantId}) delete failed: ${String(cause)}`),
    });

    return { tenantId, cutoff, reclaimed: removed.length, failed };
  });

/**
 * Walk every tenant and reclaim orphaned uploads. Per-tenant failures are
 * isolated so one broken tenant can't poison the pass — same contract as
 * `sweepAllTenants`.
 */
export const gcAllTenantAttachments = (
  opts: { readonly now?: () => Date } = {},
): Effect.Effect<
  ReadonlyArray<AttachmentGcResult>,
  never,
  DbClient | BlobStorage
> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    const now = (opts.now ?? (() => new Date()))();
    const rows = yield* Effect.tryPromise({
      try: () => db.select({ id: tenants.id }).from(tenants),
      catch: (cause) => new Error(`list tenants failed: ${String(cause)}`),
    }).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          // eslint-disable-next-line no-console
          console.error(`[attachment-gc] tenant list failed: ${e.message}`);
          return [] as ReadonlyArray<{ readonly id: string }>;
        }),
      ),
    );

    const out: Array<AttachmentGcResult> = [];
    for (const row of rows) {
      const result = yield* gcTenantAttachments(row.id, now).pipe(Effect.either);
      if (result._tag === "Right") {
        out.push(result.right);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[attachment-gc] tenant=${row.id} failed: ${result.left.message}`,
        );
      }
    }
    return out;
  });
