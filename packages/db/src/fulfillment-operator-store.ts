import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import type { WorkspaceRow } from "./dashboard-reads.js";
import {
  approvals,
  auditLog,
  ticketAttachments,
  ticketStateTransitions,
  ticketFulfillmentOperatorEscalations,
  tickets,
  memberInvitations,
  rolePermissions,
  roles,
  fulfillmentOperators,
  tenants,
} from "./schema.js";

// Plain DrizzleDb access for the fulfillmentOperator portal — mirrors member-rbac-store.ts
// (the `/dashboard/*` HTTP path uses plain db functions, not Effect service
// Tags). The agent runtime writes escalations through FulfillmentOperatorEscalationService
// (Tag in services / Live in db), but everything the fulfillment-operator-facing dashboard
// reads/writes goes through these functions.
//
// Privacy invariant: the fulfillmentOperator projections below select ONLY the denormalised
// columns on `ticket_fulfillment_operator_escalations` — never a join back to `tickets` /
// customer tables. The fulfillmentOperator sees the problem + order ref + ship-to +
// tracking, never the customer email, full address, or conversation thread.

// ---------------------------------------------------------------------------
// The constrained Fulfillment Operator role
// ---------------------------------------------------------------------------

const FULFILLMENT_OPERATOR_ROLE_NAME = "Fulfillment partner";
const FULFILLMENT_OPERATOR_PERMISSION_IDS = [
  "fulfillment_operator.tickets.view",
  "fulfillment_operator.tickets.respond",
] as const;
const fulfillmentOperatorRoleId = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(
      and(
        eq(roles.tenantId, tenantId),
        sql`lower(${roles.name}) = lower(${FULFILLMENT_OPERATOR_ROLE_NAME})`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
};

/**
 * Ensure the workspace has the constrained, non-owner FulfillmentOperator role granting
 * exactly the fulfillment_operator.tickets.* permissions. Idempotent — called lazily from the
 * fulfillment-operator-invite endpoint so any workspace gets the role on first fulfillmentOperator
 * invite (no migration backfill). Returns the role id.
 */
export const ensureFulfillmentOperatorRole = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<string> => {
  let roleId = await fulfillmentOperatorRoleId(db, tenantId);
  if (!roleId) {
    const id = randomUUID();
    await db
      .insert(roles)
      .values({
        id,
        tenantId,
        name: FULFILLMENT_OPERATOR_ROLE_NAME,
        isOwner: false,
      })
      .onConflictDoNothing();
    roleId = (await fulfillmentOperatorRoleId(db, tenantId)) ?? id;
  }
  await db
    .insert(rolePermissions)
    .values(
      FULFILLMENT_OPERATOR_PERMISSION_IDS.map((permissionId) => ({
        roleId: roleId as string,
        permissionId,
      })),
    )
    .onConflictDoNothing();
  return roleId;
};

// ---------------------------------------------------------------------------
// FulfillmentOperator identity
// ---------------------------------------------------------------------------

export interface FulfillmentOperatorIdentity {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly userDecisionUuid: string | null;
}

export const createFulfillmentOperator = async (
  db: DrizzleDb,
  tenantId: string,
  input: { readonly name: string; readonly email: string },
): Promise<{ readonly id: string }> => {
  const id = randomUUID();
  await db
    .insert(fulfillmentOperators)
    .values({ id, tenantId, name: input.name, email: input.email });
  return { id };
};

export const getFulfillmentOperatorByEmail = async (
  db: DrizzleDb,
  tenantId: string,
  email: string,
): Promise<FulfillmentOperatorIdentity | null> => {
  const rows = await db
    .select({
      id: fulfillmentOperators.id,
      name: fulfillmentOperators.name,
      email: fulfillmentOperators.email,
      userDecisionUuid: fulfillmentOperators.userDecisionUuid,
    })
    .from(fulfillmentOperators)
    .where(
      and(
        eq(fulfillmentOperators.tenantId, tenantId),
        sql`lower(${fulfillmentOperators.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

/**
 * The workspace's default fulfillmentOperator. When a workspace has more than one fulfillmentOperator
 * row, escalation routing v1 targets the oldest; per-vendor routing is a later
 * follow-up. (A fulfillmentOperator may serve many workspaces, but each workspace still
 * routes escalations to a single fulfillmentOperator here.)
 */
export const getDefaultFulfillmentOperator = async (
  db: DrizzleDb,
  tenantId: string,
): Promise<FulfillmentOperatorIdentity | null> => {
  const rows = await db
    .select({
      id: fulfillmentOperators.id,
      name: fulfillmentOperators.name,
      email: fulfillmentOperators.email,
      userDecisionUuid: fulfillmentOperators.userDecisionUuid,
    })
    .from(fulfillmentOperators)
    .where(eq(fulfillmentOperators.tenantId, tenantId))
    .orderBy(asc(fulfillmentOperators.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Bind a signed-in WorkOS user to the fulfillmentOperator row matching their email. Runs
 * on the fulfillmentOperator's first authenticated load (mirrors reconcileInvitation for
 * members). Idempotent — only fills an unbound row, so a second call is a no-op.
 */
export const bindFulfillmentOperatorUser = async (
  db: DrizzleDb,
  tenantId: string,
  email: string,
  userDecisionUuid: string,
): Promise<void> => {
  await db
    .update(fulfillmentOperators)
    .set({ userDecisionUuid })
    .where(
      and(
        eq(fulfillmentOperators.tenantId, tenantId),
        sql`lower(${fulfillmentOperators.email}) = lower(${email})`,
        sql`${fulfillmentOperators.userDecisionUuid} IS NULL`,
      ),
    );
};

export const getFulfillmentOperatorForUser = async (
  db: DrizzleDb,
  tenantId: string,
  userDecisionUuid: string,
): Promise<{ readonly id: string } | null> => {
  const rows = await db
    .select({ id: fulfillmentOperators.id })
    .from(fulfillmentOperators)
    .where(
      and(
        eq(fulfillmentOperators.tenantId, tenantId),
        eq(fulfillmentOperators.userDecisionUuid, userDecisionUuid),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Bind a signed-in WorkOS user to EVERY fulfillmentOperator row matching their email,
 * across all tenants (one fulfillmentOperator ↔ many merchants). Runs on the fulfillmentOperator
 * portal's identity-only bootstrap (`GET /dashboard/fulfillment-operator/workspaces`).
 * Idempotent — only fills currently-unbound rows, so an already-bound tenant is
 * skipped and the per-tenant unique (tenant_id, user_decision_uuid) can't trip.
 */
export const bindFulfillmentOperatorUserAllTenants = async (
  db: DrizzleDb,
  email: string,
  userDecisionUuid: string,
): Promise<void> => {
  await db
    .update(fulfillmentOperators)
    .set({ userDecisionUuid })
    .where(
      and(
        sql`lower(${fulfillmentOperators.email}) = lower(${email})`,
        sql`${fulfillmentOperators.userDecisionUuid} IS NULL`,
      ),
    );
};

/**
 * Every workspace (tenant) a signed-in fulfillmentOperator is bound to — the cross-org
 * source for the fulfillmentOperator portal's workspace switcher. Ordered oldest-first
 * (id ASC tiebreak) to match `defaultWorkspaceOrder`. Org is NOT consulted;
 * membership here is purely the `fulfillmentOperators` binding.
 */
export const listFulfillmentOperatorWorkspacesForUser = async (
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
    .from(fulfillmentOperators)
    .innerJoin(tenants, eq(tenants.id, fulfillmentOperators.tenantId))
    .where(eq(fulfillmentOperators.userDecisionUuid, userDecisionUuid))
    .orderBy(asc(tenants.createdAt), asc(tenants.id));

/**
 * Tenant ids with a still-pending invitation for this email — scopes the
 * cross-tenant reconcile loop on fulfillmentOperator bootstrap (a fulfillmentOperator invited by a
 * new merchant gets their per-tenant FulfillmentOperator role assignment on next load,
 * regardless of which org's session they signed into).
 */
export const listTenantsWithPendingFulfillmentOperatorInvitationForEmail = async (
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

/** The minimal privacy projection a fulfillmentOperator may see — no customer PII. */
export interface FulfillmentOperatorEscalationListItem {
  readonly id: string;
  readonly ticketId: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * A file the fulfillmentOperator uploaded against this escalation. Metadata only —
 * storage keys never cross the portal boundary (the opaque id is the handle).
 */
export interface FulfillmentOperatorEscalationAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface FulfillmentOperatorEscalationDetail extends FulfillmentOperatorEscalationListItem {
  readonly note: string | null;
  readonly proposedResolution: string | null;
  /** Files the fulfillmentOperator sent with their update, oldest first. */
  readonly attachments: ReadonlyArray<FulfillmentOperatorEscalationAttachment>;
}

export interface InsertEscalationInput {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly fulfillmentOperatorId: string;
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
  await db.insert(ticketFulfillmentOperatorEscalations).values({
    id,
    tenantId: input.tenantId,
    ticketId: input.ticketId,
    fulfillmentOperatorId: input.fulfillmentOperatorId,
    problem: input.problem,
    orderRef: input.orderRef,
    shipCity: input.shipCity,
    shipCountry: input.shipCountry,
    trackingNumber: input.trackingNumber,
  });
  return { id };
};

export const listOpenEscalationsForFulfillmentOperator = async (
  db: DrizzleDb,
  fulfillmentOperatorId: string,
): Promise<ReadonlyArray<FulfillmentOperatorEscalationListItem>> => {
  const rows = await db
    .select({
      id: ticketFulfillmentOperatorEscalations.id,
      ticketId: ticketFulfillmentOperatorEscalations.ticketId,
      problem: ticketFulfillmentOperatorEscalations.problem,
      orderRef: ticketFulfillmentOperatorEscalations.orderRef,
      shipCity: ticketFulfillmentOperatorEscalations.shipCity,
      shipCountry: ticketFulfillmentOperatorEscalations.shipCountry,
      trackingNumber: ticketFulfillmentOperatorEscalations.trackingNumber,
      status: ticketFulfillmentOperatorEscalations.status,
      createdAt: ticketFulfillmentOperatorEscalations.createdAt,
    })
    .from(ticketFulfillmentOperatorEscalations)
    .where(
      and(
        eq(ticketFulfillmentOperatorEscalations.fulfillmentOperatorId, fulfillmentOperatorId),
        eq(ticketFulfillmentOperatorEscalations.status, "open"),
      ),
    )
    .orderBy(asc(ticketFulfillmentOperatorEscalations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticketId,
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
 * Whether the ticket is (still) waiting on a fulfillmentOperator — i.e. at least one OPEN
 * escalation row exists for it. The row-derived source of truth for the
 * fulfillmentOperator wait under concurrent wait states: `tickets.status` may show the
 * primary wait (e.g. `waiting_for_approval`) while an open escalation keeps
 * this true. Covered by the `cse_ticket_idx` index.
 */
export const hasOpenEscalationForTicket = async (
  db: DrizzleDb,
  tenantId: string,
  ticketId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: ticketFulfillmentOperatorEscalations.id })
    .from(ticketFulfillmentOperatorEscalations)
    .where(
      and(
        eq(ticketFulfillmentOperatorEscalations.tenantId, tenantId),
        eq(ticketFulfillmentOperatorEscalations.ticketId, ticketId),
        eq(ticketFulfillmentOperatorEscalations.status, "open"),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

export const getEscalationForFulfillmentOperator = async (
  db: DrizzleDb,
  fulfillmentOperatorId: string,
  escalationId: string,
): Promise<FulfillmentOperatorEscalationDetail | null> => {
  const rows = await db
    .select({
      id: ticketFulfillmentOperatorEscalations.id,
      ticketId: ticketFulfillmentOperatorEscalations.ticketId,
      problem: ticketFulfillmentOperatorEscalations.problem,
      orderRef: ticketFulfillmentOperatorEscalations.orderRef,
      shipCity: ticketFulfillmentOperatorEscalations.shipCity,
      shipCountry: ticketFulfillmentOperatorEscalations.shipCountry,
      trackingNumber: ticketFulfillmentOperatorEscalations.trackingNumber,
      status: ticketFulfillmentOperatorEscalations.status,
      note: ticketFulfillmentOperatorEscalations.note,
      proposedResolution: ticketFulfillmentOperatorEscalations.proposedResolution,
      createdAt: ticketFulfillmentOperatorEscalations.createdAt,
    })
    .from(ticketFulfillmentOperatorEscalations)
    .where(
      and(
        eq(ticketFulfillmentOperatorEscalations.id, escalationId),
        eq(ticketFulfillmentOperatorEscalations.fulfillmentOperatorId, fulfillmentOperatorId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // The files the fulfillmentOperator uploaded against this escalation. Bound by
  // escalation_id, so a sibling escalation on the same ticket never leaks in.
  const attachments = await db
    .select({
      id: ticketAttachments.id,
      filename: ticketAttachments.filename,
      contentType: ticketAttachments.contentType,
      sizeBytes: ticketAttachments.sizeBytes,
    })
    .from(ticketAttachments)
    .where(eq(ticketAttachments.escalationId, r.id))
    .orderBy(ticketAttachments.createdAt);
  return {
    id: r.id,
    ticketId: r.ticketId,
    problem: r.problem,
    orderRef: r.orderRef,
    shipCity: r.shipCity,
    shipCountry: r.shipCountry,
    trackingNumber: r.trackingNumber,
    status: r.status,
    note: r.note,
    proposedResolution: r.proposedResolution,
    createdAt: r.createdAt.toISOString(),
    attachments,
  };
};

// ---------------------------------------------------------------------------
// The closed-loop write: fulfillmentOperator submits an update
// ---------------------------------------------------------------------------

export interface RecordFulfillmentOperatorUpdateInput {
  readonly tenantId: string;
  readonly fulfillmentOperatorId: string;
  readonly escalationId: string;
  readonly note: string;
  readonly proposedResolution: string | null;
  /**
   * `ticket_attachments` ids the fulfillmentOperator uploaded for this update. Each must
   * be a `source='fulfillment_operator'` row on the escalation's own ticket — anything
   * else fails the whole update (`attachment_not_found`).
   */
  readonly attachmentIds?: ReadonlyArray<string>;
  /** The fulfillmentOperator's decision UUID, for the audit actor. */
  readonly actorUuid: string;
}

export type RecordFulfillmentOperatorUpdateResult =
  | {
      readonly kind: "recorded";
      readonly ticketId: string;
      /** True when the ticket was flipped waiting_for_fulfillment_operator → in_progress. */
      readonly resumed: boolean;
      /** Validated update attachments (id + filename), for the event payload. */
      readonly attachments: ReadonlyArray<{
        readonly id: string;
        readonly filename: string;
      }>;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_resolved" }
  | { readonly kind: "attachment_not_found" };

/**
 * The statuses a fulfillmentOperator update flips back to `in_progress`. A ticket can escape
 * `waiting_for_fulfillment_operator` while its escalation is still open (manual status
 * change, "Take over", a manual reply resolving it, restart from triage) — the
 * fulfillmentOperator's answer must STILL re-engage the agent, so every such resting state
 * resumes. All are matrix-legal `→ in_progress` moves.
 *
 * `waiting_for_approval` resumes too, but is special: under concurrent wait
 * states a ticket can hold a pending approval AND an open escalation at once
 * (`primaryWaitStatus` = approval). When the fulfillmentOperator answers, the pending
 * draft(s) may be stale in light of the note, so the flip ALSO supersedes every
 * pending approval (redraft) — the re-run agent produces a fresh draft. See the
 * supersede block in `recordFulfillmentOperatorUpdate`.
 *
 * Deliberately absent: the active states (`in_progress`, `new`, `triaging` —
 * nothing to flip; the published event re-enters the loop directly).
 */
const FULFILLMENT_OPERATOR_RESUMABLE_STATUSES: ReadonlySet<string> = new Set([
  "waiting_for_fulfillment_operator",
  "waiting_for_customer",
  "waiting_for_approval",
  "resolved",
  "archived",
  "failed",
  "human_takeover",
]);

/**
 * The fulfillmentOperator's reply, recorded atomically (master-plan §4 outbox): resolve the
 * escalation, flip the ticket back to `in_progress` from any resting status
 * ({@link FULFILLMENT_OPERATOR_RESUMABLE_STATUSES}), stamp the note onto ticket context, and
 * write the audit row — all in ONE transaction. The caller then ALWAYS
 * publishes `fulfillment_operator.updated` (flip-then-publish, like retryTicketNow) so the
 * agent re-engages; `resumed: false` only means no status flip was needed (or,
 * for a pending approval, allowed — the runtime park guard holds that event).
 */
export const recordFulfillmentOperatorUpdate = async (
  db: DrizzleDb,
  input: RecordFulfillmentOperatorUpdateInput,
): Promise<RecordFulfillmentOperatorUpdateResult> => {
  const existing = await db
    .select({
      id: ticketFulfillmentOperatorEscalations.id,
      ticketId: ticketFulfillmentOperatorEscalations.ticketId,
      status: ticketFulfillmentOperatorEscalations.status,
    })
    .from(ticketFulfillmentOperatorEscalations)
    .where(
      and(
        eq(ticketFulfillmentOperatorEscalations.id, input.escalationId),
        eq(ticketFulfillmentOperatorEscalations.tenantId, input.tenantId),
        eq(ticketFulfillmentOperatorEscalations.fulfillmentOperatorId, input.fulfillmentOperatorId),
      ),
    )
    .limit(1);
  const esc = existing[0];
  if (!esc) return { kind: "not_found" };
  if (esc.status !== "open") return { kind: "already_resolved" };

  // Resolve update attachments before any write: every id must be a
  // fulfillment-operator-uploaded row bound to THIS escalation — an id from another
  // ticket/tenant, a merchant upload, or a file uploaded against a different
  // escalation on the same ticket fails the update outright rather than
  // silently dropping out.
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  const attachmentRows =
    attachmentIds.length === 0
      ? []
      : await db
          .select({
            id: ticketAttachments.id,
            filename: ticketAttachments.filename,
          })
          .from(ticketAttachments)
          .where(
            and(
              eq(ticketAttachments.tenantId, input.tenantId),
              eq(ticketAttachments.ticketId, esc.ticketId),
              eq(ticketAttachments.source, "fulfillment_operator"),
              eq(ticketAttachments.escalationId, input.escalationId),
              inArray(ticketAttachments.id, attachmentIds),
            ),
          );
  if (attachmentRows.length !== attachmentIds.length) {
    return { kind: "attachment_not_found" };
  }
  const attachments = attachmentRows.map((r) => ({
    id: r.id,
    filename: r.filename,
  }));

  const resumed = await db.transaction(async (tx) => {
    await tx
      .update(ticketFulfillmentOperatorEscalations)
      .set({
        note: input.note,
        proposedResolution: input.proposedResolution,
        status: "resolved",
        resolvedAt: new Date(),
      })
      .where(eq(ticketFulfillmentOperatorEscalations.id, input.escalationId));

    // The posted update is a durable reference to these files (ticket context
    // + the agent's forwarding prompt), so the GC sweep must leave them alone.
    // Same tx as the update itself: a file is "used" iff the update committed.
    if (attachmentIds.length > 0) {
      await tx
        .update(ticketAttachments)
        .set({ usedAt: new Date() })
        .where(
          and(
            inArray(ticketAttachments.id, attachmentIds),
            isNull(ticketAttachments.usedAt),
          ),
        );
    }

    const ticketRows = await tx
      .select({ status: tickets.status, context: tickets.context })
      .from(tickets)
      .where(
        and(eq(tickets.id, esc.ticketId), eq(tickets.tenantId, input.tenantId)),
      )
      .limit(1);
    const ticketRow = ticketRows[0];
    const willResume =
      ticketRow !== undefined &&
      FULFILLMENT_OPERATOR_RESUMABLE_STATUSES.has(ticketRow.status);

    if (ticketRow) {
      const mergedContext = {
        ...(ticketRow.context as Record<string, unknown>),
        fulfillmentOperatorUpdate: {
          fulfillmentOperatorId: input.fulfillmentOperatorId,
          note: input.note,
          proposedResolution: input.proposedResolution,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      };
      if (willResume) {
        // Concurrent wait states: the ticket was parked `waiting_for_approval`
        // with an open escalation. The fulfillmentOperator's answer may make the pending
        // draft(s) stale, so supersede every pending approval (mirror
        // `supersedePendingForTicket` field semantics exactly) before the re-run
        // agent drafts fresh. `applyApprovalDecision` returns `already_decided`
        // for non-pending rows, so any stale approve link is an inert 409.
        if (ticketRow.status === "waiting_for_approval") {
          const superseded = await tx
            .update(approvals)
            .set({
              status: "cancelled",
              decidedAt: new Date(),
              decidedBy: null,
              decisionReason: "superseded by fulfillment operator update",
            })
            .where(
              and(
                eq(approvals.tenantId, input.tenantId),
                eq(approvals.ticketId, esc.ticketId),
                eq(approvals.status, "pending"),
              ),
            )
            .returning({ id: approvals.id });
          if (superseded.length > 0) {
            await tx.insert(auditLog).values({
              tenantId: input.tenantId,
              ticketId: esc.ticketId,
              actorType: "user",
              actorId: input.actorUuid,
              action: "approval.superseded",
              details: {
                count: superseded.length,
                reason: "fulfillment operator update",
              },
            });
          }
        }
        await tx
          .update(tickets)
          .set({
            status: "in_progress",
            context: mergedContext,
            updatedAt: new Date(),
          })
          .where(eq(tickets.id, esc.ticketId));
        await tx.insert(ticketStateTransitions).values({
          ticketId: esc.ticketId,
          fromStatus: ticketRow.status,
          toStatus: "in_progress",
          reason: "fulfillment_operator.updated",
        });
      } else {
        await tx
          .update(tickets)
          .set({ context: mergedContext, updatedAt: new Date() })
          .where(eq(tickets.id, esc.ticketId));
      }
    }

    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      ticketId: esc.ticketId,
      actorType: "user",
      actorId: input.actorUuid,
      action: "fulfillment_operator.updated",
      details: {
        escalationId: input.escalationId,
        fulfillmentOperatorId: input.fulfillmentOperatorId,
        resumed: willResume,
        hasProposedResolution: input.proposedResolution !== null,
      },
    });

    return willResume;
  });

  return { kind: "recorded", ticketId: esc.ticketId, resumed, attachments };
};

// ---------------------------------------------------------------------------
// FulfillmentOperator tracking edit — bookkeeping after the Shopify write
// ---------------------------------------------------------------------------

export interface RecordFulfillmentOperatorTrackingUpdateInput {
  readonly tenantId: string;
  readonly fulfillmentOperatorId: string;
  readonly escalationId: string;
  /** The fulfillmentOperator's decision UUID, for the audit actor. */
  readonly actorUuid: string;
  readonly fulfillmentId: string;
  readonly previousTrackingNumber: string | null;
  readonly trackingNumber: string;
  readonly trackingCompany: string | null;
}

/**
 * Bookkeeping for a fulfillmentOperator's tracking-number edit, AFTER the Shopify
 * fulfillment write succeeded: re-stamp the escalation's tracking projection
 * (so the portal and the merchant's escalation view show the new number),
 * drop the ticket's stale `liveTrackingStatus` cache (the tracking card would
 * otherwise keep rendering the OLD number until the next lookup), and write
 * the audit row — all in ONE transaction (§4: audit shares the tx with the
 * state it describes). Never called for a foreign escalation — the handler
 * resolves the escalation through `getEscalationForFulfillmentOperator` first.
 */
export const recordFulfillmentOperatorTrackingUpdate = async (
  db: DrizzleDb,
  input: RecordFulfillmentOperatorTrackingUpdateInput,
): Promise<void> => {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(ticketFulfillmentOperatorEscalations)
      .set({ trackingNumber: input.trackingNumber })
      .where(
        and(
          eq(ticketFulfillmentOperatorEscalations.id, input.escalationId),
          eq(ticketFulfillmentOperatorEscalations.tenantId, input.tenantId),
          eq(ticketFulfillmentOperatorEscalations.fulfillmentOperatorId, input.fulfillmentOperatorId),
        ),
      )
      .returning({ ticketId: ticketFulfillmentOperatorEscalations.ticketId });
    const ticketId = updated[0]?.ticketId;
    if (!ticketId) return;

    const ticketRows = await tx
      .select({ context: tickets.context })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, input.tenantId)))
      .limit(1);
    const ticketRow = ticketRows[0];
    if (ticketRow) {
      const context = { ...(ticketRow.context as Record<string, unknown>) };
      context["trackingFulfillmentId"] = input.fulfillmentId;
      if ("liveTrackingStatus" in context) {
        delete context["liveTrackingStatus"];
      }
      await tx
        .update(tickets)
        .set({ context, updatedAt: new Date() })
        .where(eq(tickets.id, ticketId));
    }

    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      ticketId,
      actorType: "user",
      actorId: input.actorUuid,
      action: "fulfillment_operator.tracking_updated",
      details: {
        escalationId: input.escalationId,
        fulfillmentOperatorId: input.fulfillmentOperatorId,
        fulfillmentId: input.fulfillmentId,
        previousTrackingNumber: input.previousTrackingNumber,
        trackingNumber: input.trackingNumber,
        trackingCompany: input.trackingCompany,
      },
    });
  });
};

// ---------------------------------------------------------------------------
// Notification outbox (the worker sweep — §10)
// ---------------------------------------------------------------------------

export interface UnsentFulfillmentOperatorEscalation {
  readonly id: string;
  readonly ticketId: string;
  readonly tenantId: string;
  readonly fulfillmentOperatorEmail: string;
  readonly problem: string;
  readonly orderRef: string | null;
  readonly notifyAttempts: number;
}

/**
 * Escalations whose fulfillmentOperator email hasn't been sent yet (the durable outbox):
 * `notified_at IS NULL` and under the retry cap, oldest first. Joined to the
 * fulfillmentOperator for the recipient address. Keys on the ESCALATION ROW being open —
 * not on the ticket sitting in `waiting_for_fulfillment_operator` — because under concurrent
 * wait states a ticket can carry an open escalation while parked
 * `waiting_for_approval` (or actively in_progress) and the fulfillmentOperator still
 * needs the email. Tickets a human closed or owns are excluded: never email a
 * fulfillmentOperator about a ticket that is resolved, failed, or under human takeover.
 */
export const listUnsentFulfillmentOperatorEscalations = async (
  db: DrizzleDb,
  limit: number,
  maxAttempts: number,
): Promise<ReadonlyArray<UnsentFulfillmentOperatorEscalation>> => {
  const rows = await db
    .select({
      id: ticketFulfillmentOperatorEscalations.id,
      ticketId: ticketFulfillmentOperatorEscalations.ticketId,
      tenantId: ticketFulfillmentOperatorEscalations.tenantId,
      fulfillmentOperatorEmail: fulfillmentOperators.email,
      problem: ticketFulfillmentOperatorEscalations.problem,
      orderRef: ticketFulfillmentOperatorEscalations.orderRef,
      notifyAttempts: ticketFulfillmentOperatorEscalations.notifyAttempts,
    })
    .from(ticketFulfillmentOperatorEscalations)
    .innerJoin(fulfillmentOperators, eq(fulfillmentOperators.id, ticketFulfillmentOperatorEscalations.fulfillmentOperatorId))
    .innerJoin(tickets, eq(tickets.id, ticketFulfillmentOperatorEscalations.ticketId))
    .where(
      and(
        sql`${ticketFulfillmentOperatorEscalations.notifiedAt} IS NULL`,
        sql`${ticketFulfillmentOperatorEscalations.notifyAttempts} < ${maxAttempts}`,
        eq(ticketFulfillmentOperatorEscalations.status, "open"),
        notInArray(tickets.status, [
          "resolved",
          "archived",
          "failed",
          "human_takeover",
        ]),
      ),
    )
    .orderBy(asc(ticketFulfillmentOperatorEscalations.createdAt))
    .limit(limit);
  return rows;
};

/** Stamp a successful fulfillmentOperator notification so the sweep stops retrying it. */
export const markFulfillmentOperatorEscalationNotified = async (
  db: DrizzleDb,
  id: string,
): Promise<void> => {
  await db
    .update(ticketFulfillmentOperatorEscalations)
    .set({ notifiedAt: new Date() })
    .where(eq(ticketFulfillmentOperatorEscalations.id, id));
};

/**
 * Record a failed send: bump the attempt counter (so the retry cap eventually
 * trips) and keep the last error for visibility. `notified_at` stays NULL so
 * the next sweep retries it until the cap.
 */
export const recordFulfillmentOperatorNotifyFailure = async (
  db: DrizzleDb,
  id: string,
  error: string,
): Promise<void> => {
  await db
    .update(ticketFulfillmentOperatorEscalations)
    .set({
      notifyAttempts: sql`${ticketFulfillmentOperatorEscalations.notifyAttempts} + 1`,
      lastNotifyError: error.slice(0, 500),
    })
    .where(eq(ticketFulfillmentOperatorEscalations.id, id));
};
