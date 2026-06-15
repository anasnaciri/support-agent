import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import {
  auditLog,
  caseStateTransitions,
  caseSupplierEscalations,
  cases,
  rolePermissions,
  roles,
  suppliers,
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
 * The workspace's default supplier (one supplier ↔ one workspace). When a
 * workspace has more than one supplier row, escalation routing v1 targets the
 * oldest; per-vendor routing is a later follow-up.
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
 * The supplier's reply, recorded atomically (master-plan §4 outbox): resolve the
 * escalation, flip the case OFF `waiting_for_supplier`, stamp the note onto case
 * context, and write the audit row — all in ONE transaction. The caller then
 * publishes `supplier.updated` (flip-then-publish, like retryCaseNow) so the
 * agent re-engages. Only flips a case that is actually `waiting_for_supplier`;
 * if a human took it over in the meantime the note is still recorded but the
 * case is left alone (`resumed: false`).
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
    const willResume = caseRow?.status === "waiting_for_supplier";

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
          fromStatus: "waiting_for_supplier",
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
