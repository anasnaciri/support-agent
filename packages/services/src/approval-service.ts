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
  /**
   * The case round (`Case.epoch`) this approval belongs to. Defaults to 0.
   * A later round bumps the case epoch; approvals stamped with an older epoch
   * are stale and are fenced out of bundle execution + the maintenance sweep.
   */
  readonly epoch?: number;
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

export interface SupersedePendingForCaseInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  /** Recorded as the cancelled rows' decisionReason (audit trail). */
  readonly reason: string;
  /**
   * When set, only pending rows whose `tool` is in this set are superseded
   * (e.g. `["conversation.reply"]` to cancel just stale email drafts). Omit to
   * supersede every pending row for the case.
   */
  readonly tools?: ReadonlyArray<string>;
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

    /**
     * Mark an approval's decision as ACTED ON (sets `resumedAt`). Called by the
     * runtime after it executes, dedups, or deliberately skips a decision.
     * Idempotent — a row already resumed stays resumed. A resumed row is never
     * re-run by a later bundle nor re-published by the maintenance sweep. No-op
     * (not an error) when the approval is missing/cross-tenant (audit D9).
     */
    readonly markResumed: (
      id: ApprovalId,
      tenantId?: TenantId,
    ) => Effect.Effect<void, ApprovalServiceError>;

    readonly listPending: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError>;

    /**
     * Every approval row for a case, in creation order (oldest first). Used by
     * the autonomous-loop bundle resume (slice 4d): one approve event executes
     * the whole queued bundle, so the runtime needs all of a case's rows — not
     * just the pending ones — to run the `approved` ones in proposal order.
     */
    readonly listForCase: (
      tenantId: TenantId,
      caseId: CaseId,
    ) => Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError>;

    /**
     * Cancel every pending approval for a case after an authoritative manual
     * lifecycle write. Returns the number of rows changed.
     */
    readonly cancelPendingForCase: (
      input: CancelPendingForCaseInput,
    ) => Effect.Effect<number, ApprovalServiceError>;

    /**
     * Supersede every pending approval for a case: a SYSTEM-initiated cancel
     * (status → `cancelled`, `decidedBy` null) used when the agent re-engages a
     * case and re-decides — the prior run's still-pending proposals (e.g. a draft
     * reply queued before a supplier replied) are stale and the new run replaces
     * them. Distinct from `cancelPendingForCase` (a human/manual reject that
     * needs a `decidedBy`). Returns the number of rows changed.
     */
    readonly supersedePendingForCase: (
      input: SupersedePendingForCaseInput,
    ) => Effect.Effect<number, ApprovalServiceError>;

    /**
     * APPROVED, not-yet-resumed approvals older than `decidedBefore` whose case
     * is STILL parked in `waiting_for_approval` (audit L3b): the decision
     * committed but its workflow event was never published (or was lost), so the
     * runtime never resumed. The maintenance sweep re-publishes their events;
     * re-delivery is idempotent.
     *
     * Deliberately EXCLUDES rejected/cancelled rows (a rejection has nothing to
     * re-run — republishing one only re-forces human_takeover) and rows already
     * marked `resumedAt` (recovery hardening).
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
            epoch: input.epoch ?? 0,
            resumedAt: null,
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

      markResumed: (id, tenantId) =>
        Effect.sync(() => {
          const a = scoped(id, tenantId);
          if (a && !a.resumedAt) store.set(id, { ...a, resumedAt: new Date() });
        }),

      // In-memory approximation: no case table to join, so this returns
      // APPROVED, unresumed rows older than the cutoff; the maintenance sweep
      // re-checks the case status + epoch itself before republishing. Rejected
      // rows are excluded (nothing to re-run) as is anything already resumed.
      listDecidedUnresumed: ({ decidedBefore, limit = 100 }) =>
        Effect.sync(() => {
          const out: Approval[] = [];
          for (const a of store.values()) {
            if (out.length >= limit) break;
            if (a.status !== "approved") continue;
            if (a.resumedAt) continue;
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

      // Map iteration is insertion order, which mirrors the Live impl's
      // `ORDER BY created_at ASC` for rows created in sequence.
      listForCase: (tenantId, caseId) =>
        Effect.sync(() => {
          const out: Approval[] = [];
          for (const a of store.values()) {
            if (a.tenantId === tenantId && a.caseId === caseId) {
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

      supersedePendingForCase: (input) =>
        Effect.sync(() => {
          const toolFilter = input.tools ? new Set(input.tools) : null;
          let superseded = 0;
          for (const [id, approval] of store.entries()) {
            if (approval.tenantId !== input.tenantId) continue;
            if (approval.caseId !== input.caseId) continue;
            if (approval.status !== "pending") continue;
            if (toolFilter && !toolFilter.has(approval.tool)) continue;
            store.set(id, {
              ...approval,
              status: "cancelled",
              decidedBy: null,
              decidedAt: new Date(),
              decisionReason: input.reason,
            });
            superseded += 1;
          }
          return superseded;
        }),
    });
  }),
);
