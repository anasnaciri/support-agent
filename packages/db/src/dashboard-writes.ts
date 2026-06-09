import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import {
  approvals,
  auditLog,
  caseStateTransitions,
  cases,
  tenants,
} from "./schema.js";
import type { OnboardingResult } from "@support-agent/dashboard-contracts";
import type { LegalAcceptance } from "@support-agent/services";

// Write operations backing the dashboard's HTTP API (Path B). Ported from
// the dashboard's lib/case-actions.ts so the api owns the mutation (the
// Workers dashboard can't open a Postgres pool). Raw drizzle tx, not the
// Effect services, to keep the audit-in-transaction invariant (§4) in one
// place without dragging the runtime stack in.

export type TakeOverOutcome =
  | { readonly kind: "taken_over"; readonly canceledApprovals: number }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "already_terminal"; readonly status: string };

export interface TakeOverInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

export type ResumeOutcome =
  | { readonly kind: "resumed"; readonly toStatus: string }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: string };

export interface ResumeInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

/** Status a resumed case lands in: actively owned by automation again. */
const RESUME_TO_STATUS = "in_progress";

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "resolved",
  "human_takeover",
  "failed",
]);

/**
 * Transition a case to `human_takeover`, cancel its pending approvals (so a
 * stale email-link click can't resume it), and write the transition + audit
 * rows in one tx. Cross-tenant ids surface as `case_not_found` (never
 * disclose existence); terminal cases are a no-op.
 */
export const takeOverCase = async (
  db: DrizzleDb,
  input: TakeOverInput,
): Promise<TakeOverOutcome> =>
  db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(
        and(eq(cases.id, input.caseId), eq(cases.tenantId, input.tenantId)),
      )
      .limit(1);
    if (!caseRow) return { kind: "case_not_found" } as TakeOverOutcome;
    if (TERMINAL_STATES.has(caseRow.status)) {
      return {
        kind: "already_terminal",
        status: caseRow.status,
      } as TakeOverOutcome;
    }

    const reason = input.reason ?? "manager takeover from dashboard";

    await tx
      .update(cases)
      .set({ status: "human_takeover", updatedAt: sql`now()` })
      .where(eq(cases.id, input.caseId));

    await tx.insert(caseStateTransitions).values({
      caseId: input.caseId as never,
      fromStatus: caseRow.status,
      toStatus: "human_takeover",
      reason,
    });

    await tx.insert(auditLog).values({
      tenantId: input.tenantId as never,
      caseId: input.caseId as never,
      actorType: "user",
      actorId: input.managerId,
      action: "case.taken_over",
      details: { reason, fromStatus: caseRow.status },
    });

    const canceled = await tx
      .update(approvals)
      .set({
        status: "rejected",
        decidedAt: sql`now()`,
        decidedBy: input.managerId as never,
        decisionReason: "case taken over",
      })
      .where(
        and(
          eq(approvals.caseId, input.caseId),
          eq(approvals.status, "pending"),
        ),
      )
      .returning({ id: approvals.id });

    return { kind: "taken_over", canceledApprovals: canceled.length };
  });

/**
 * Hand a `human_takeover` case back to the agent: transition it to
 * `in_progress` and write the transition + audit rows in one tx. The case
 * re-enters automation on its next inbound event — the runtime's takeover
 * guard only holds events while the status is `human_takeover`, so flipping
 * the status is all that's needed (the runtime has no message-history replay,
 * so we deliberately don't re-trigger the agent on the already-seen reply).
 * Only acts from `human_takeover`; any other status is a no-op
 * (`not_in_takeover`). Cross-tenant ids surface as `case_not_found`.
 */
export const resumeCase = async (
  db: DrizzleDb,
  input: ResumeInput,
): Promise<ResumeOutcome> =>
  db.transaction(async (tx) => {
    const [caseRow] = await tx
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(
        and(eq(cases.id, input.caseId), eq(cases.tenantId, input.tenantId)),
      )
      .limit(1);
    if (!caseRow) return { kind: "case_not_found" } as ResumeOutcome;
    if (caseRow.status !== "human_takeover") {
      return { kind: "not_in_takeover", status: caseRow.status } as ResumeOutcome;
    }

    const reason = input.reason ?? "manager handed the case back from dashboard";

    await tx
      .update(cases)
      .set({ status: RESUME_TO_STATUS, updatedAt: sql`now()` })
      .where(eq(cases.id, input.caseId));

    await tx.insert(caseStateTransitions).values({
      caseId: input.caseId as never,
      fromStatus: caseRow.status,
      toStatus: RESUME_TO_STATUS,
      reason,
    });

    await tx.insert(auditLog).values({
      tenantId: input.tenantId as never,
      caseId: input.caseId as never,
      actorType: "user",
      actorId: input.managerId,
      action: "case.resumed",
      details: { reason, fromStatus: caseRow.status },
    });

    return { kind: "resumed", toStatus: RESUME_TO_STATUS };
  });

/**
 * Self-service tenant creation for a signed-in WorkOS org (ported from the
 * dashboard's onboarding action). Idempotent by org: the partial unique index
 * on `workos_organization_id` rejects a second row, so a re-submit / two-tab
 * race resolves to the existing tenant with `alreadyExisted: true`.
 */
export const createTenantForOrg = async (
  db: DrizzleDb,
  input: {
    readonly organizationId: string;
    readonly name: string;
    readonly notificationEmail: string;
    readonly legalAcceptance: LegalAcceptance;
  },
): Promise<OnboardingResult> => {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, input.organizationId))
    .limit(1);
  if (existing[0]) return { tenantId: existing[0].id, alreadyExisted: true };

  const id = randomUUID();
  try {
    await db.insert(tenants).values({
      id,
      name: input.name,
      workosOrganizationId: input.organizationId,
      settings: {
        notificationEmail: input.notificationEmail,
        legalAcceptance: input.legalAcceptance,
      },
    });
    return { tenantId: id, alreadyExisted: false };
  } catch (cause) {
    // Most likely the unique index — another tab won the race. Re-read.
    const [row] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.workosOrganizationId, input.organizationId))
      .limit(1);
    if (row) return { tenantId: row.id, alreadyExisted: true };
    throw cause;
  }
};
