import { randomUUID } from "node:crypto";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import type { WorkspaceRow } from "./dashboard-reads.js";
import {
  approvals,
  auditLog,
  caseStateTransitions,
  caseSupplierEscalations,
  cases,
  memberInvitations,
  rolePermissions,
  roles,
  suppliers,
  tenants,
} from "./schema.js";

// Plain DrizzleDb access for the supplier portal — mirrors member-rbac-store.ts
// (the `/dashboard/*` HTTP path uses plain db functions, not Effect service
// Tags). The agent runtime writes escalations through SupplierEscalationService
// (Tag in services / Live in db), but everything the supplier-facing dashboard
// reads/writes goes through these functions.
//
// Privacy invariant: the supplier projections below select ONLY the denormalised
// columns on `case_supplier_escalations` — never a join back to `cases` /
// customer tables. The supplier sees the problem + order ref + ship-to +
// tracking, never the customer email, full address, or conversation thread.

// ---------------------------------------------------------------------------
// The constrained Supplier role
// ---------------------------------------------------------------------------

const SUPPLIER_ROLE_NAME = "Supplier";
const SUPPLIER_PERMISSION_IDS = [
  "supplier.cases.view",
  "supplier.cases.respond",
] as const;

const supplierRoleId = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        sql`lower(${roles.name}) = lower(${SUPPLIER_ROLE_NAME})`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
};

/**
 * Ensure the workspace has the constrained, non-owner "Supplier" role granting
 * exactly the supplier.cases.* permissions. Idempotent — called lazily from the
 * supplier-invite endpoint so any workspace gets the role on first supplier
 * invite (no migration backfill). Returns the role id.
 */
export const ensureSupplierRole = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string> => {
  let roleId = await supplierRoleId(db, tenantId);
  if (!roleId) {
    const id = randomUUID();
    await db
      .insert(roles)
      .values({ id, tenantId, name: SUPPLIER_ROLE_NAME, isOwner: false })
      .onConflictDoNothing();
    roleId = (await supplierRoleId(db, tenantId)) ?? id;
  }
  await db
    .insert(rolePermissions)
    .values(
      SUPPLIER_PERMISSION_IDS.map((permissionId) => ({
        roleId: roleId as string,
        permissionId,
      })),
    )
    .onConflictDoNothing();
  return roleId;
};

// ---------------------------------------------------------------------------
// Supplier identity
// ---------------------------------------------------------------------------

export interface SupplierIdentity {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly userDecisionUuid: string | null;
}

export const createSupplier = async (
  db: DrizzleDb,
  tenantId: string,
  input: { readonly name: string; readonly email: string },
): Promise<{ readonly id: string }> => {
  const id = randomUUID();
  await db
    .insert(suppliers)
    .values({ id, tenantId, name: input.name, email: input.email });
  return { id };
};

export const getSupplierByEmail = async (
  db: DrizzleDb,
  tenantId: string,
  email: string,
): Promise<SupplierIdentity | null> => {
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      userDecisionUuid: suppliers.userDecisionUuid,
    })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.tenantId, tenantId),
        sql`lower(${suppliers.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

/**
 * The workspace's default supplier. When a workspace has more than one supplier
 * row, escalation routing v1 targets the oldest; per-vendor routing is a later
 * follow-up. (A supplier may serve many workspaces, but each workspace still
 * routes escalations to a single supplier here.)
 */
export const getDefaultSupplier = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<SupplierIdentity | null> => {
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      email: suppliers.email,
      userDecisionUuid: suppliers.userDecisionUuid,
    })
    .from(suppliers)
    .where(eq(suppliers.tenantId, tenantId))
    .orderBy(asc(suppliers.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Bind a signed-in WorkOS user to the supplier row matching their email. Runs
 * on the supplier's first authenticated load (mirrors reconcileInvitation for
 * members). Idempotent — only fills an unbound row, so a second call is a no-op.
 */
export const bindSupplierUser = async (
  db: DrizzleDb,
  tenantId: string,
  email: string,
  userDecisionUuid: string,
): Promise<void> => {
  await db
    .update(suppliers)
    .set({ userDecisionUuid })
    .where(
      and(
        eq(suppliers.tenantId, tenantId),
        sql`lower(${suppliers.email}) = lower(${email})`,
        sql`${suppliers.userDecisionUuid} IS NULL`,
      ),
    );
};

export const getSupplierForUser = async (
  db: DrizzleDb,
  tenantId: string,
  userDecisionUuid: string,
): Promise<{ readonly id: string } | null> => {
  const rows = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(
      and(
        eq(suppliers.tenantId, tenantId),
        eq(suppliers.userDecisionUuid, userDecisionUuid),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Bind a signed-in WorkOS user to EVERY supplier row matching their email,
 * across all tenants (one supplier ↔ many merchants). Runs on the supplier
 * portal's identity-only bootstrap (`GET /dashboard/supplier/workspaces`).
 * Idempotent — only fills currently-unbound rows, so an already-bound tenant is
 * skipped and the per-tenant unique (tenant_id, user_decision_uuid) can't trip.
 */
export const bindSupplierUserAllTenants = async (
  db: DrizzleDb,
  email: string,
  userDecisionUuid: string,
): Promise<void> => {
  await db
    .update(suppliers)
    .set({ userDecisionUuid })
    .where(
      and(
        sql`lower(${suppliers.email}) = lower(${email})`,
        sql`${suppliers.userDecisionUuid} IS NULL`,
      ),
    );
};

/**
 * Every workspace (tenant) a signed-in supplier is bound to — the cross-org
 * source for the supplier portal's workspace switcher. Ordered oldest-first
 * (id ASC tiebreak) to match `defaultWorkspaceOrder`. Org is NOT consulted;
 * membership here is purely the `suppliers` binding.
 */
export const listSupplierWorkspacesForUser = async (
  db: DrizzleDb,
  userDecisionUuid: string,
): Promise<ReadonlyArray<WorkspaceRow>> =>
  db
    .select({
      id: tenants.id,
      name: tenants.name,
      createdAt: tenants.createdAt,
      shopifyDomain: tenants.shopifyDomain,
    })
    .from(suppliers)
    .innerJoin(tenants, eq(tenants.id, suppliers.tenantId))
    .where(eq(suppliers.userDecisionUuid, userDecisionUuid))
    .orderBy(asc(tenants.createdAt), asc(tenants.id));

/**
 * Tenant ids with a still-pending invitation for this email — scopes the
 * cross-tenant reconcile loop on supplier bootstrap (a supplier invited by a
 * new merchant gets their per-tenant Supplier role assignment on next load,
 * regardless of which org's session they signed into).
 */
export const listTenantsWithPendingSupplierInvitationForEmail = async (
  db: DrizzleDb,
  email: string,
): Promise<ReadonlyArray<string>> => {
  const rows = await db
    .select({ tenantId: memberInvitations.tenantId })
    .from(memberInvitations)
    .where(
      and(
        sql`lower(${memberInvitations.email}) = lower(${email})`,
        eq(memberInvitations.status, "pending"),
      ),
    );
  return [...new Set(rows.map((r) => r.tenantId))];
};

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

/** The minimal privacy projection a supplier may see — no customer PII. */
export interface SupplierEscalationListItem {
  readonly id: string;
  readonly caseId: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
  readonly status: string;
  readonly createdAt: string;
}

export interface SupplierEscalationDetail extends SupplierEscalationListItem {
  readonly note: string | null;
  readonly proposedResolution: string | null;
}

export interface InsertEscalationInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly supplierId: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
}

export const insertEscalation = async (
  db: DrizzleDb,
  input: InsertEscalationInput,
): Promise<{ readonly id: string }> => {
  const id = randomUUID();
  await db.insert(caseSupplierEscalations).values({
    id,
    tenantId: input.tenantId,
    caseId: input.caseId,
    supplierId: input.supplierId,
    problem: input.problem,
    orderRef: input.orderRef,
    shipCity: input.shipCity,
    shipCountry: input.shipCountry,
    trackingNumber: input.trackingNumber,
  });
  return { id };
};

export const listOpenEscalationsForSupplier = async (
  db: DrizzleDb,
  supplierId: string,
): Promise<ReadonlyArray<SupplierEscalationListItem>> => {
  const rows = await db
    .select({
      id: caseSupplierEscalations.id,
      caseId: caseSupplierEscalations.caseId,
      problem: caseSupplierEscalations.problem,
      orderRef: caseSupplierEscalations.orderRef,
      shipCity: caseSupplierEscalations.shipCity,
      shipCountry: caseSupplierEscalations.shipCountry,
      trackingNumber: caseSupplierEscalations.trackingNumber,
      status: caseSupplierEscalations.status,
      createdAt: caseSupplierEscalations.createdAt,
    })
    .from(caseSupplierEscalations)
    .where(
      and(
        eq(caseSupplierEscalations.supplierId, supplierId),
        eq(caseSupplierEscalations.status, "open"),
      ),
    )
    .orderBy(asc(caseSupplierEscalations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    problem: r.problem,
    orderRef: r.orderRef,
    shipCity: r.shipCity,
    shipCountry: r.shipCountry,
    trackingNumber: r.trackingNumber,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
};

/**
 * Whether the case is (still) waiting on a supplier — i.e. at least one OPEN
 * escalation row exists for it. The row-derived source of truth for the
 * supplier wait under concurrent wait states: `cases.status` may show the
 * primary wait (e.g. `waiting_for_approval`) while an open escalation keeps
 * this true. Covered by the `cse_case_idx` index.
 */
export const hasOpenEscalationForCase = async (
  db: DrizzleDb,
  tenantId: string,
  caseId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: caseSupplierEscalations.id })
    .from(caseSupplierEscalations)
    .where(
      and(
        eq(caseSupplierEscalations.tenantId, tenantId),
        eq(caseSupplierEscalations.caseId, caseId),
        eq(caseSupplierEscalations.status, "open"),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

export const getEscalationForSupplier = async (
  db: DrizzleDb,
  supplierId: string,
  escalationId: string,
): Promise<SupplierEscalationDetail | null> => {
  const rows = await db
    .select({
      id: caseSupplierEscalations.id,
      caseId: caseSupplierEscalations.caseId,
      problem: caseSupplierEscalations.problem,
      orderRef: caseSupplierEscalations.orderRef,
      shipCity: caseSupplierEscalations.shipCity,
      shipCountry: caseSupplierEscalations.shipCountry,
      trackingNumber: caseSupplierEscalations.trackingNumber,
      status: caseSupplierEscalations.status,
      note: caseSupplierEscalations.note,
      proposedResolution: caseSupplierEscalations.proposedResolution,
      createdAt: caseSupplierEscalations.createdAt,
    })
    .from(caseSupplierEscalations)
    .where(
      and(
        eq(caseSupplierEscalations.id, escalationId),
        eq(caseSupplierEscalations.supplierId, supplierId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    caseId: r.caseId,
    problem: r.problem,
    orderRef: r.orderRef,
    shipCity: r.shipCity,
    shipCountry: r.shipCountry,
    trackingNumber: r.trackingNumber,
    status: r.status,
    note: r.note,
    proposedResolution: r.proposedResolution,
    createdAt: r.createdAt.toISOString(),
  };
};

// ---------------------------------------------------------------------------
// The closed-loop write: supplier submits an update
// ---------------------------------------------------------------------------

export interface RecordSupplierUpdateInput {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly escalationId: string;
  readonly note: string;
  readonly proposedResolution: string | null;
  /** The supplier's decision UUID, for the audit actor. */
  readonly actorUuid: string;
}

export type RecordSupplierUpdateResult =
  | {
      readonly kind: "recorded";
      readonly caseId: string;
      /** True when the case was flipped waiting_for_supplier → in_progress. */
      readonly resumed: boolean;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_resolved" };

/**
 * The statuses a supplier update flips back to `in_progress`. A case can escape
 * `waiting_for_supplier` while its escalation is still open (manual status
 * change, "Take over", a manual reply resolving it, restart from triage) — the
 * supplier's answer must STILL re-engage the agent, so every such resting state
 * resumes. All are matrix-legal `→ in_progress` moves.
 *
 * `waiting_for_approval` resumes too, but is special: under concurrent wait
 * states a case can hold a pending approval AND an open escalation at once
 * (`primaryWaitStatus` = approval). When the supplier answers, the pending
 * draft(s) may be stale in light of the note, so the flip ALSO supersedes every
 * pending approval (redraft) — the re-run agent produces a fresh draft. See the
 * supersede block in `recordSupplierUpdate`.
 *
 * Deliberately absent: the active states (`in_progress`, `new`, `triaging` —
 * nothing to flip; the published event re-enters the loop directly).
 */
const SUPPLIER_RESUMABLE_STATUSES: ReadonlySet<string> = new Set([
  "waiting_for_supplier",
  "waiting_for_customer",
  "waiting_for_approval",
  "resolved",
  "archived",
  "failed",
  "human_takeover",
]);

/**
 * The supplier's reply, recorded atomically (master-plan §4 outbox): resolve the
 * escalation, flip the case back to `in_progress` from any resting status
 * ({@link SUPPLIER_RESUMABLE_STATUSES}), stamp the note onto case context, and
 * write the audit row — all in ONE transaction. The caller then ALWAYS
 * publishes `supplier.updated` (flip-then-publish, like retryCaseNow) so the
 * agent re-engages; `resumed: false` only means no status flip was needed (or,
 * for a pending approval, allowed — the runtime park guard holds that event).
 */
export const recordSupplierUpdate = async (
  db: DrizzleDb,
  input: RecordSupplierUpdateInput,
): Promise<RecordSupplierUpdateResult> => {
  const existing = await db
    .select({
      id: caseSupplierEscalations.id,
      caseId: caseSupplierEscalations.caseId,
      status: caseSupplierEscalations.status,
    })
    .from(caseSupplierEscalations)
    .where(
      and(
        eq(caseSupplierEscalations.id, input.escalationId),
        eq(caseSupplierEscalations.tenantId, input.tenantId),
        eq(caseSupplierEscalations.supplierId, input.supplierId),
      ),
    )
    .limit(1);
  const esc = existing[0];
  if (!esc) return { kind: "not_found" };
  if (esc.status !== "open") return { kind: "already_resolved" };

  const resumed = await db.transaction(async (tx) => {
    await tx
      .update(caseSupplierEscalations)
      .set({
        note: input.note,
        proposedResolution: input.proposedResolution,
        status: "resolved",
        resolvedAt: new Date(),
      })
      .where(eq(caseSupplierEscalations.id, input.escalationId));

    const caseRows = await tx
      .select({ status: cases.status, context: cases.context })
      .from(cases)
      .where(
        and(eq(cases.id, esc.caseId), eq(cases.tenantId, input.tenantId)),
      )
      .limit(1);
    const caseRow = caseRows[0];
    const willResume =
      caseRow !== undefined &&
      SUPPLIER_RESUMABLE_STATUSES.has(caseRow.status);

    if (caseRow) {
      const mergedContext = {
        ...(caseRow.context as Record<string, unknown>),
        supplierUpdate: {
          supplierId: input.supplierId,
          note: input.note,
          proposedResolution: input.proposedResolution,
        },
      };
      if (willResume) {
        // Concurrent wait states: the case was parked `waiting_for_approval`
        // with an open escalation. The supplier's answer may make the pending
        // draft(s) stale, so supersede every pending approval (mirror
        // `supersedePendingForCase` field semantics exactly) before the re-run
        // agent drafts fresh. `applyApprovalDecision` returns `already_decided`
        // for non-pending rows, so any stale approve link is an inert 409.
        if (caseRow.status === "waiting_for_approval") {
          const superseded = await tx
            .update(approvals)
            .set({
              status: "cancelled",
              decidedAt: new Date(),
              decidedBy: null,
              decisionReason: "superseded by supplier update",
            })
            .where(
              and(
                eq(approvals.tenantId, input.tenantId),
                eq(approvals.caseId, esc.caseId),
                eq(approvals.status, "pending"),
              ),
            )
            .returning({ id: approvals.id });
          if (superseded.length > 0) {
            await tx.insert(auditLog).values({
              tenantId: input.tenantId,
              caseId: esc.caseId,
              actorType: "user",
              actorId: input.actorUuid,
              action: "approval.superseded",
              details: {
                count: superseded.length,
                reason: "supplier update",
              },
            });
          }
        }
        await tx
          .update(cases)
          .set({
            status: "in_progress",
            context: mergedContext,
            updatedAt: new Date(),
          })
          .where(eq(cases.id, esc.caseId));
        await tx.insert(caseStateTransitions).values({
          caseId: esc.caseId,
          fromStatus: caseRow.status,
          toStatus: "in_progress",
          reason: "supplier.updated",
        });
      } else {
        await tx
          .update(cases)
          .set({ context: mergedContext, updatedAt: new Date() })
          .where(eq(cases.id, esc.caseId));
      }
    }

    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      caseId: esc.caseId,
      actorType: "user",
      actorId: input.actorUuid,
      action: "supplier.updated",
      details: {
        escalationId: input.escalationId,
        supplierId: input.supplierId,
        resumed: willResume,
        hasProposedResolution: input.proposedResolution !== null,
      },
    });

    return willResume;
  });

  return { kind: "recorded", caseId: esc.caseId, resumed };
};

// ---------------------------------------------------------------------------
// Notification outbox (the worker sweep — §10)
// ---------------------------------------------------------------------------

export interface UnsentSupplierEscalation {
  readonly id: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly supplierEmail: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly notifyAttempts: number;
}

/**
 * Escalations whose supplier email hasn't been sent yet (the durable outbox):
 * `notified_at IS NULL` and under the retry cap, oldest first. Joined to the
 * supplier for the recipient address. Keys on the ESCALATION ROW being open —
 * not on the case sitting in `waiting_for_supplier` — because under concurrent
 * wait states a case can carry an open escalation while parked
 * `waiting_for_approval` (or actively in_progress) and the supplier still
 * needs the email. Cases a human closed or owns are excluded: never email a
 * supplier about a case that is resolved, failed, or under human takeover.
 */
export const listUnsentSupplierEscalations = async (
  db: DrizzleDb,
  limit: number,
  maxAttempts: number,
): Promise<ReadonlyArray<UnsentSupplierEscalation>> => {
  const rows = await db
    .select({
      id: caseSupplierEscalations.id,
      caseId: caseSupplierEscalations.caseId,
      tenantId: caseSupplierEscalations.tenantId,
      supplierEmail: suppliers.email,
      problem: caseSupplierEscalations.problem,
      orderRef: caseSupplierEscalations.orderRef,
      notifyAttempts: caseSupplierEscalations.notifyAttempts,
    })
    .from(caseSupplierEscalations)
    .innerJoin(suppliers, eq(suppliers.id, caseSupplierEscalations.supplierId))
    .innerJoin(cases, eq(cases.id, caseSupplierEscalations.caseId))
    .where(
      and(
        sql`${caseSupplierEscalations.notifiedAt} IS NULL`,
        sql`${caseSupplierEscalations.notifyAttempts} < ${maxAttempts}`,
        eq(caseSupplierEscalations.status, "open"),
        notInArray(cases.status, [
          "resolved",
          "archived",
          "failed",
          "human_takeover",
        ]),
      ),
    )
    .orderBy(asc(caseSupplierEscalations.createdAt))
    .limit(limit);
  return rows;
};

/** Stamp a successful supplier notification so the sweep stops retrying it. */
export const markSupplierEscalationNotified = async (
  db: DrizzleDb,
  id: string,
): Promise<void> => {
  await db
    .update(caseSupplierEscalations)
    .set({ notifiedAt: new Date() })
    .where(eq(caseSupplierEscalations.id, id));
};

/**
 * Record a failed send: bump the attempt counter (so the retry cap eventually
 * trips) and keep the last error for visibility. `notified_at` stays NULL so
 * the next sweep retries it until the cap.
 */
export const recordSupplierNotifyFailure = async (
  db: DrizzleDb,
  id: string,
  error: string,
): Promise<void> => {
  await db
    .update(caseSupplierEscalations)
    .set({
      notifyAttempts: sql`${caseSupplierEscalations.notifyAttempts} + 1`,
      lastNotifyError: error.slice(0, 500),
    })
    .where(eq(caseSupplierEscalations.id, id));
};
