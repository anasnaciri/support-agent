import "server-only";
import { and, eq, sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  caseStateTransitions,
  cases,
} from "@support-agent/db";
import { db } from "./db";

// ============================================================
// Take Over a case
// ============================================================
//
// Master-plan §13 mock's "Take Over" button. Transitions the case to
// `human_takeover` regardless of its current status (except terminal),
// cancels any pending approvals on the case (so a lingering email-link
// click can't resume), and writes the audit + transition rows in one
// SQL tx (master-plan §4 audit-in-transaction invariant).
//
// We do this with raw drizzle rather than the Effect ApprovalService /
// CaseRepository because the dashboard isn't built on Effect — pulling
// in the runtime stack just for one tx would be more code, not less.

export type TakeOverOutcome =
  | { readonly kind: "taken_over"; readonly canceledApprovals: number }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "already_terminal"; readonly status: string };

export interface TakeOverInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "resolved",
  "human_takeover",
  "failed",
]);

export const takeOverCase = async (
  input: TakeOverInput,
): Promise<TakeOverOutcome> => {
  return db().transaction(async (tx) => {
    // 1. Verify the case belongs to the tenant. Cross-tenant ids
    //    surface as `case_not_found` — never disclose existence.
    const [caseRow] = await tx
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(
        and(eq(cases.id, input.caseId), eq(cases.tenantId, input.tenantId)),
      )
      .limit(1);
    if (!caseRow) {
      return { kind: "case_not_found" } as TakeOverOutcome;
    }

    // 2. Already terminal? No-op — keep the existing state. The button
    //    in the UI is hidden in this case but a stale form post could
    //    still land here, so be defensive.
    if (TERMINAL_STATES.has(caseRow.status)) {
      return {
        kind: "already_terminal",
        status: caseRow.status,
      } as TakeOverOutcome;
    }

    const reason = input.reason ?? "manager takeover from dashboard";

    // 3. Transition the case + write the case_state_transitions row +
    //    audit. All in this tx (§4 invariant).
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
      details: {
        reason,
        fromStatus: caseRow.status,
      },
    });

    // 4. Cancel pending approvals on this case. A manager who's taking
    //    over has decided the agent's draft isn't going out — leaving
    //    the approval pending would mean a stale email-link click
    //    could resume the case days later.
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

    return {
      kind: "taken_over",
      canceledApprovals: canceled.length,
    } as TakeOverOutcome;
  });
};
