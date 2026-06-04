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
      settings: { notificationEmail: input.notificationEmail },
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
