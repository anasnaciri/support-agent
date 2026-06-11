import { Effect } from "effect";
import {
  ApprovalId as makeApprovalId,
  type Approval,
  type ApprovalId,
  type DomainEvent,
  type TenantId,
  type UserId,
} from "@support-agent/agent-core";
import { ApprovalService } from "./approval-service.js";

// ============================================================
// Apply an approval decision
// ============================================================
//
// The token-free inner core of "the manager said yes/no". Both apps/api
// (verifies a signed token from the email link) and apps/dashboard
// (uses the WorkOS session) call this once they've established the
// caller is allowed to act on the approval. Everything here is
// transport-agnostic.
//
// The function deliberately returns `approval_not_found` for cross-
// tenant access when a `tenantId` scope is provided — we never want
// the caller to learn that an id exists in another tenant.

export type ApprovalDecisionResult =
  | { readonly kind: "decided"; readonly approval: Approval }
  | { readonly kind: "already_decided"; readonly approval: Approval }
  | { readonly kind: "approval_not_found" }
  /**
   * The row is still pending but past its `expiresAt` (audit L7): the
   * proposed input is stale — the order, policy, or conversation may
   * have changed since the agent drafted it — so neither surface may
   * decide it. The runtime's resume branch enforces the same rule.
   */
  | { readonly kind: "expired"; readonly approval: Approval };

export interface ApplyApprovalDecisionInput {
  readonly approvalId: string;
  readonly action: "approve" | "reject";
  readonly managerId: UserId;
  /**
   * When set, the function checks that the approval belongs to this
   * tenant. Cross-tenant ids surface as `approval_not_found`. Leave
   * undefined when the caller has already verified ownership (e.g. the
   * email-link flow where the signed token IS the auth).
   */
  readonly tenantId?: TenantId;
  /**
   * Manager-edited override for the tool input. Only honored on
   * `action: "approve"` — ignored for reject. The runtime resume
   * branch reads `approval.approvedInput ?? approval.proposedInput`
   * so passing this here is what actually changes what the customer
   * sees. Use for "Edit reply & approve" UX flows.
   */
  readonly approvedInput?: unknown;
}

export const applyApprovalDecision = (
  input: ApplyApprovalDecisionInput,
): Effect.Effect<ApprovalDecisionResult, never, ApprovalService> =>
  Effect.gen(function* () {
    const svc = yield* ApprovalService;
    const approvalIdTyped: ApprovalId = makeApprovalId(input.approvalId);

    // 1. Pre-fetch. Lets us return `already_decided` on a re-click
    //    without burning a state-conflict path, AND scope by tenant.
    const existingEither = yield* svc
      .getById(approvalIdTyped)
      .pipe(Effect.either);
    if (existingEither._tag === "Left") {
      return { kind: "approval_not_found" };
    }
    const existing = existingEither.right;

    // 2. Tenant scope. The api endpoint binds tenancy via its signed
    //    token + email recipient; the dashboard binds it via the
    //    WorkOS session. Both pass `tenantId` so a row that exists in
    //    another tenant looks identical to a row that doesn't exist.
    if (input.tenantId && existing.tenantId !== input.tenantId) {
      return { kind: "approval_not_found" };
    }

    if (existing.status !== "pending") {
      return { kind: "already_decided", approval: existing };
    }

    // 2.5. Expiry (audit L7). `expiresAt` was previously written but
    // never enforced anywhere — a manager could approve a months-stale
    // draft against a long-changed order.
    if (existing.expiresAt.getTime() < Date.now()) {
      return { kind: "expired", approval: existing };
    }

    // 3. Apply the decision. `approvedInput` is honored only for
    //    `approve` — the runtime reads it via
    //    `approval.approvedInput ?? approval.proposedInput`, which is
    //    how Edit-and-Approve actually changes what the customer sees.
    const decided = yield* (input.action === "approve"
      ? svc.approve({
          id: approvalIdTyped,
          decidedBy: input.managerId,
          ...(input.approvedInput !== undefined
            ? { approvedInput: input.approvedInput }
            : {}),
        })
      : svc.reject({ id: approvalIdTyped, decidedBy: input.managerId })
    ).pipe(Effect.either);

    if (decided._tag === "Left") {
      // Only state conflicts are idempotency/race conditions. Other
      // failures are real write failures (for example a DB type error) and
      // must not be reported as "already_decided" while the row remains
      // pending.
      if (decided.left._tag !== "ApprovalStateConflict") {
        return yield* Effect.die(decided.left);
      }

      // A concurrent decision may have won the race. Re-read to surface it
      // as already_decided, but only when the row actually left pending.
      const reread = yield* svc
        .getById(approvalIdTyped)
        .pipe(Effect.either);
      if (reread._tag === "Right" && reread.right.status !== "pending") {
        return { kind: "already_decided", approval: reread.right };
      }
      return yield* Effect.die(decided.left);
    }

    return { kind: "decided", approval: decided.right };
  });

// ============================================================
// Convert a decided result into the matching DomainEvent
// ============================================================
//
// Centralised so apps/api and apps/dashboard can't drift on event
// shape. Returns null for non-`decided` outcomes (no event should fire).

export const decisionToEvent = (
  result: ApprovalDecisionResult,
  action: "approve" | "reject",
  managerId: UserId,
): DomainEvent | null => {
  if (result.kind !== "decided") return null;
  return action === "approve"
    ? {
        type: "approval.approved",
        approvalId: result.approval.id,
        caseId: result.approval.caseId,
        managerId,
      }
    : {
        type: "approval.rejected",
        approvalId: result.approval.id,
        caseId: result.approval.caseId,
        managerId,
      };
};
