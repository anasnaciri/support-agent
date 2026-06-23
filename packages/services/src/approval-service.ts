import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import {
  ApprovalId as makeApprovalId,
  type AgentId,
  type Approval,
  type ApprovalId,
  type ApprovalRiskLevel,
  type ApprovalStatus,
  type CaseId,
  type TenantId,
  type UserId,
} from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export class ApprovalNotFound extends Data.TaggedError("ApprovalNotFound")<{
  readonly approvalId: ApprovalId;
}> {}

export class ApprovalStateConflict extends Data.TaggedError(
  "ApprovalStateConflict",
)<{
  readonly approvalId: ApprovalId;
  readonly expected: ApprovalStatus;
  readonly actual: ApprovalStatus;
}> {}

export class ApprovalServiceDbError extends Data.TaggedError(
  "ApprovalServiceDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type ApprovalServiceError =
  | ApprovalNotFound
  | ApprovalStateConflict
  | ApprovalServiceDbError;

// ============================================================
// Inputs
// ============================================================

export interface CreateApprovalInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly reasoning: string;
  readonly riskLevel: ApprovalRiskLevel;
  readonly expiresAt: Date;
}

export interface ApproveInput {
  readonly id: ApprovalId;
  readonly decidedBy: UserId;
  /** Set when the manager edited the proposed input before approving. */
  readonly approvedInput?: unknown;
  readonly decisionReason?: string | null;
  /**
   * Defense-in-depth tenant scope (audit D9): when present, an approval
   * outside the tenant is treated as not found and nothing is decided.
   */
  readonly tenantId?: TenantId;
}

export interface RejectInput {
  readonly id: ApprovalId;
  readonly decidedBy: UserId;
  readonly decisionReason?: string | null;
  /** See {@link ApproveInput.tenantId} (audit D9). */
  readonly tenantId?: TenantId;
}

export interface CancelPendingForCaseInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly decidedBy: UserId;
  readonly decisionReason: string;
}

// ============================================================
// Tag
// ============================================================

/**
 * `tenantId` on the bare-id methods (`getById`, `approve`/`reject` via their
 * inputs) is OPTIONAL for caller compatibility but ENFORCED when present
 * (audit D9): an approval under another tenant behaves exactly like a
 * missing one (`ApprovalNotFound`). New callers should always pass it.
 */
export class ApprovalService extends Context.Tag("ApprovalService")<
  ApprovalService,
  {
    readonly create: (
      input: CreateApprovalInput,
    ) => Effect.Effect<Approval, ApprovalServiceError>;

    readonly getById: (
      id: ApprovalId,
      tenantId?: TenantId,
    ) => Effect.Effect<Approval, ApprovalServiceError>;

    readonly approve: (
      input: ApproveInput,
    ) => Effect.Effect<Approval, ApprovalServiceError>;

    readonly reject: (
      input: RejectInput,
    ) => Effect.Effect<Approval, ApprovalServiceError>;

    readonly listPending: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError>;

    /**
     * Cancel every pending approval for a case after an authoritative manual
     * lifecycle write. Returns the number of rows changed.
     */
    readonly cancelPendingForCase: (
      input: CancelPendingForCaseInput,
    ) => Effect.Effect<number, ApprovalServiceError>;

    /**
     * Flip `pending` rows past their `expiresAt` to `expired` (audit L7).
     * Returns the rows it expired so the caller can escalate their cases.
     * CAS on pending — racing deciders win cleanly.
     */
    readonly expireOverdue: (
      now: Date,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError>;

    /**
     * Decided (approved/rejected) approvals older than `decidedBefore`
     * whose case is STILL parked in `waiting_for_approval` (audit L3b):
     * the decision committed but the workflow event was never published
     * (or was lost), so the runtime never resumed. The maintenance sweep
     * re-publishes their events; re-delivery is idempotent.
     */
    readonly listDecidedUnresumed: (opts: {
      readonly decidedBefore: Date;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError>;
  }
>() {}

// ============================================================
// Test layer — in-memory
// ============================================================

export const ApprovalServiceTest = Layer.effect(
  ApprovalService,
  Effect.sync(() => {
    const store = new Map<string, Approval>();

    // D9: a cross-tenant approval is indistinguishable from a missing one.
    const scoped = (id: ApprovalId, tenantId?: TenantId): Approval | null => {
      const a = store.get(id);
      if (!a) return null;
      if (tenantId !== undefined && a.tenantId !== tenantId) return null;
      return a;
    };

    const transition = (
      id: ApprovalId,
      expected: ApprovalStatus,
      patch: Partial<Approval>,
      tenantId?: TenantId,
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.suspend((): Effect.Effect<Approval, ApprovalServiceError> => {
        const existing = scoped(id, tenantId);
        if (!existing)
          return Effect.fail(new ApprovalNotFound({ approvalId: id }));
        if (existing.status !== expected) {
          return Effect.fail(
            new ApprovalStateConflict({
              approvalId: id,
              expected,
              actual: existing.status,
            }),
          );
        }
        const next: Approval = { ...existing, ...patch };
        store.set(id, next);
        return Effect.succeed(next);
      });

    return ApprovalService.of({
      create: (input) =>
        Effect.sync(() => {
          const id = makeApprovalId(randomUUID());
          const approval: Approval = {
            id,
            tenantId: input.tenantId,
            caseId: input.caseId,
            agentId: input.agentId,
            tool: input.tool,
            proposedInput: input.proposedInput,
            approvedInput: null,
            reasoning: input.reasoning,
            riskLevel: input.riskLevel,
            status: "pending",
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
            expiresAt: input.expiresAt,
            createdAt: new Date(),
          };
          store.set(id, approval);
          return approval;
        }),

      getById: (id, tenantId) =>
        Effect.suspend((): Effect.Effect<Approval, ApprovalServiceError> => {
          const a = scoped(id, tenantId);
          return a
            ? Effect.succeed(a)
            : Effect.fail(new ApprovalNotFound({ approvalId: id }));
        }),

      approve: (input) =>
        transition(
          input.id,
          "pending",
          {
            status: "approved",
            decidedBy: input.decidedBy,
            decidedAt: new Date(),
            decisionReason: input.decisionReason ?? null,
            approvedInput:
              input.approvedInput !== undefined ? input.approvedInput : null,
          },
          input.tenantId,
        ),

      reject: (input) =>
        transition(
          input.id,
          "pending",
          {
            status: "rejected",
            decidedBy: input.decidedBy,
            decidedAt: new Date(),
            decisionReason: input.decisionReason ?? null,
          },
          input.tenantId,
        ),

      expireOverdue: (now, limit = 100) =>
        Effect.sync(() => {
          const expired: Approval[] = [];
          for (const a of store.values()) {
            if (expired.length >= limit) break;
            if (a.status !== "pending") continue;
            if (a.expiresAt.getTime() >= now.getTime()) continue;
            const next: Approval = { ...a, status: "expired" };
            store.set(a.id, next);
            expired.push(next);
          }
          return expired;
        }),

      // In-memory approximation: no case table to join, so this returns
      // decided rows older than the cutoff; the maintenance sweep
      // re-checks the case status itself before republishing.
      listDecidedUnresumed: ({ decidedBefore, limit = 100 }) =>
        Effect.sync(() => {
          const out: Approval[] = [];
          for (const a of store.values()) {
            if (out.length >= limit) break;
            if (a.status !== "approved" && a.status !== "rejected") continue;
            if (!a.decidedAt || a.decidedAt.getTime() >= decidedBefore.getTime())
              continue;
            out.push(a);
          }
          return out;
        }),

      listPending: (tenantId) =>
        Effect.sync(() => {
          const out: Approval[] = [];
          for (const a of store.values()) {
            if (a.tenantId === tenantId && a.status === "pending") {
              out.push(a);
            }
          }
          return out;
        }),

      cancelPendingForCase: (input) =>
        Effect.sync(() => {
          let canceled = 0;
          for (const [id, approval] of store.entries()) {
            if (approval.tenantId !== input.tenantId) continue;
            if (approval.caseId !== input.caseId) continue;
            if (approval.status !== "pending") continue;
            store.set(id, {
              ...approval,
              status: "rejected",
              decidedBy: input.decidedBy,
              decidedAt: new Date(),
              decisionReason: input.decisionReason,
            });
            canceled += 1;
          }
          return canceled;
        }),
    });
  }),
);
