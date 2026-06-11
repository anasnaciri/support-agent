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
    });
  }),
);
