import { Context, Effect, Layer, Option } from "effect";
import {
  isMerchantSettableStatus,
  isStatusTransitionAllowed,
  type AgentId,
  type Approval,
  type ApprovalRiskLevel,
  type Case,
  type CaseContext,
  type CaseId,
  type CaseStatus,
  type TenantId,
  type UserId,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  type ApprovalServiceError,
} from "./approval-service.js";
import {
  type AuditLogError,
  AuditLogService,
  type AuditActor,
} from "./audit-log.js";
import {
  CaseRepository,
  type CaseRepositoryError,
} from "./case-repository.js";
import {
  REPLY_DELIVERY_FAILED_FLAG,
  ReplyDeliveryService,
  type ReplyDeliveryError,
} from "./reply-delivery.js";
import {
  ToolExecutionStore,
  type IdempotencyStoreDbError,
} from "./idempotency-store.js";
import { TransactionRunner } from "./transaction-runner.js";

type LifecycleDetails = Readonly<Record<string, unknown>>;

export interface EscalateToHumanInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly details?: LifecycleDetails;
  readonly riskFlag?: string;
  readonly onlyFromStatus?: CaseStatus;
  readonly action?: string;
}

export interface ResolveCaseInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly details?: LifecycleDetails;
  readonly clearRiskFlags?: ReadonlyArray<string>;
  readonly bridgeFromHumanTakeover?: boolean;
  readonly action?: string;
}

export interface ParkForApprovalInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly proposedInput: unknown;
  readonly reasoning: string;
  readonly riskLevel: ApprovalRiskLevel;
  readonly expiresAt: Date;
  readonly turn: number;
}

export interface ParkForApprovalResult {
  readonly approval: Approval;
  readonly case_: Case;
}

export interface ParkForWaitInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly tool: string;
  readonly callId: string;
}

export interface ReopenForCustomerReplyInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly eventType: string;
}

export interface ParkForReplyDeliveryFailureInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId | string;
  readonly tool: string;
  readonly draftInput: unknown;
  readonly error: unknown;
  readonly executionKey: string;
}

export interface ApplyAgentStatusUpdateInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly agentId: AgentId | string;
  readonly toStatus: CaseStatus;
  readonly reason?: string;
  readonly expectedFromStatus?: CaseStatus;
  readonly tool: string;
  readonly callId: string;
}

export type TakeOverCaseOutcome =
  | { readonly kind: "taken_over"; readonly canceledApprovals: number }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "already_terminal"; readonly status: CaseStatus };

export interface TakeOverCaseInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly decidedBy: UserId;
  readonly reason: string;
}

export type ResumeCaseOutcome =
  | { readonly kind: "resumed"; readonly toStatus: CaseStatus }
  | { readonly kind: "case_not_found" }
  | { readonly kind: "not_in_takeover"; readonly status: CaseStatus };

export interface ResumeCaseInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly reason: string;
  /**
   * Full retry from triage. The runtime always re-runs `current_agent_id`, so a
   * plain resume re-runs the already-bound specialist and never re-routes. When
   * set, the resume ALSO rebinds the case to support-triage and clears the
   * stale `classification` (in the same tx) so the next tick re-classifies and
   * re-routes — the only way a deployed routing change reaches an in-flight,
   * already-routed case. Enrichment + the customer's reason (`notes`) are kept,
   * since triage has no message-replay and re-classifies from context.
   */
  readonly restartFromTriage?: boolean;
}

export type SetMerchantStatusOutcome =
  | {
      readonly kind: "updated";
      readonly fromStatus: CaseStatus;
      readonly toStatus: CaseStatus;
      readonly canceledApprovals: number;
    }
  | { readonly kind: "unchanged"; readonly status: CaseStatus }
  | { readonly kind: "invalid_status"; readonly status: string }
  | {
      readonly kind: "transition_not_allowed";
      readonly fromStatus: CaseStatus;
      readonly toStatus: CaseStatus;
    }
  | { readonly kind: "case_not_found" };

export interface SetMerchantStatusInput {
  readonly caseId: CaseId;
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly decidedBy: UserId;
  readonly toStatus: string;
  readonly reason: string;
}

export type CaseLifecycleWriterError =
  | ApprovalServiceError
  | CaseRepositoryError
  | AuditLogError
  | IdempotencyStoreDbError
  | ReplyDeliveryError;

export class CaseLifecycleWriter extends Context.Tag("CaseLifecycleWriter")<
  CaseLifecycleWriter,
  {
    readonly escalateToHuman: (
      input: EscalateToHumanInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly resolve: (
      input: ResolveCaseInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly parkForApproval: (
      input: ParkForApprovalInput,
    ) => Effect.Effect<ParkForApprovalResult, CaseLifecycleWriterError>;

    readonly parkWaitingForCustomer: (
      input: ParkForWaitInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly parkWaitingForSupplier: (
      input: ParkForWaitInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly reopenForCustomerReply: (
      input: ReopenForCustomerReplyInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly parkForReplyDeliveryFailure: (
      input: ParkForReplyDeliveryFailureInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly applyAgentStatusUpdate: (
      input: ApplyAgentStatusUpdateInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly takeOver: (
      input: TakeOverCaseInput,
    ) => Effect.Effect<TakeOverCaseOutcome, CaseLifecycleWriterError>;

    readonly resume: (
      input: ResumeCaseInput,
    ) => Effect.Effect<ResumeCaseOutcome, CaseLifecycleWriterError>;

    readonly setMerchantStatus: (
      input: SetMerchantStatusInput,
    ) => Effect.Effect<SetMerchantStatusOutcome, CaseLifecycleWriterError>;
  }
>() {}

const auditDetails = (
  reason: string,
  details: LifecycleDetails | undefined,
): LifecycleDetails => ({ reason, ...(details ?? {}) });

const readRiskFlags = (context: CaseContext): ReadonlyArray<string> =>
  Array.isArray(context["riskFlags"])
    ? context["riskFlags"].filter(
        (flag): flag is string => typeof flag === "string",
      )
    : [];

const withRiskFlag = (
  context: CaseContext,
  flag: string,
): CaseContext | null => {
  const current = readRiskFlags(context);
  if (current.includes(flag)) return null;
  return { ...context, riskFlags: [...current, flag] };
};

const withoutRiskFlags = (
  context: CaseContext,
  flagsToClear: ReadonlyArray<string>,
): CaseContext | null => {
  if (flagsToClear.length === 0) return null;
  const clearSet = new Set(flagsToClear);
  const current = readRiskFlags(context);
  const next = current.filter((flag) => !clearSet.has(flag));
  if (next.length === current.length) return null;
  return { ...context, riskFlags: next };
};

const replyDeliveryErrorLabel = (error: unknown): string => {
  const issues = (error as { readonly issues?: unknown } | null)?.issues;
  const errTag = (error as { readonly _tag?: unknown } | null)?._tag;
  return Array.isArray(issues) && issues.length > 0
    ? issues.filter((i): i is string => typeof i === "string").join(",")
    : typeof errTag === "string"
      ? errTag
      : "ConversationSendFailed";
};

const replyDeliveryDraftId = (
  caseId: CaseId,
  tool: string,
  draftInput: unknown,
): string => {
  const rawDraftId = (draftInput as { readonly draftId?: unknown } | null)
    ?.draftId;
  return typeof rawDraftId === "string" && rawDraftId.length > 0
    ? rawDraftId
    : `${caseId}:${tool}`;
};

const RESUME_TO_STATUS = "in_progress" satisfies CaseStatus;
// The primary/triage agent every case is born on. A `restartFromTriage` resume
// rebinds here so the next tick re-classifies + re-routes. Mirrors the runtime's
// hardcoded create-time agent id.
const PRIMARY_AGENT_ID = "support-triage" as AgentId;

const TERMINAL_TAKEOVER_STATUSES: ReadonlySet<CaseStatus> = new Set([
  "resolved",
  "human_takeover",
  "failed",
]);

export const CaseLifecycleWriterLive = Layer.effect(
  CaseLifecycleWriter,
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const tx = yield* TransactionRunner;
    const maybeReplyDelivery = yield* Effect.serviceOption(ReplyDeliveryService);
    const maybeExecutions = yield* Effect.serviceOption(ToolExecutionStore);

    return CaseLifecycleWriter.of({
      escalateToHuman: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases.getById(input.caseId, input.tenantId);
            if (
              input.onlyFromStatus !== undefined &&
              current.status !== input.onlyFromStatus
            ) {
              return current;
            }

            let working = current;
            if (input.riskFlag) {
              const patchedContext = withRiskFlag(
                working.context,
                input.riskFlag,
              );
              if (patchedContext) {
                working = yield* cases.update(
                  working.id,
                  { context: patchedContext },
                  working.tenantId,
                );
              }
            }

            const updated =
              working.status === "human_takeover"
                ? working
                : yield* cases.transitionStatus(working.id, "human_takeover", {
                    tenantId: working.tenantId,
                    reason: input.reason,
                  });

            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: input.actor,
              action: input.action ?? "case.escalated_to_human",
              details: auditDetails(input.reason, input.details),
            });
            return updated;
          }),
        ),

      resolve: (input) =>
        tx.run(
          Effect.gen(function* () {
            let current = yield* cases.getById(input.caseId, input.tenantId);
            if (current.status === "resolved") return current;

            // Bypass-proof identity-disclosure backstop (prod 3428f154): an
            // AGENT must never resolve a case that still carries an UNVERIFIED
            // order/customer mismatch — we never confirmed who we're talking to,
            // so closing it would swallow a live case. This reads the FRESH
            // in-transaction context (not a possibly-stale in-memory copy the
            // runtime's loop guard relies on), so it holds no matter how the
            // resolve was reached. Manual (user) and system resolves are allowed
            // — a human owns that decision.
            const unverifiedMismatch =
              readRiskFlags(current.context).includes(
                "order_customer_mismatch",
              ) && current.context["identityVerified"] !== true;
            if (input.actor.type === "agent" && unverifiedMismatch) {
              const parked = yield* cases.transitionStatus(
                current.id,
                "human_takeover",
                {
                  tenantId: current.tenantId,
                  reason: "unverified_identity_mismatch_resolve_blocked",
                },
              );
              yield* audit.record({
                tenantId: parked.tenantId,
                caseId: parked.id,
                actor: { type: "system", id: "case-lifecycle-writer" },
                action: "case.escalated_to_human",
                details: auditDetails(
                  "unverified_identity_mismatch_resolve_blocked",
                  input.details,
                ),
              });
              return parked;
            }

            if (
              current.status === "human_takeover" &&
              input.bridgeFromHumanTakeover === true
            ) {
              current = yield* cases.transitionStatus(
                current.id,
                "in_progress",
                {
                  tenantId: current.tenantId,
                  reason: input.reason,
                },
              );
            }

            const patchedContext = withoutRiskFlags(
              current.context,
              input.clearRiskFlags ?? [],
            );
            if (patchedContext) {
              current = yield* cases.update(
                current.id,
                { context: patchedContext },
                current.tenantId,
              );
            }

            const resolved = yield* cases.transitionStatus(
              current.id,
              "resolved",
              {
                tenantId: current.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: resolved.tenantId,
              caseId: resolved.id,
              actor: input.actor,
              action: input.action ?? "case.resolved",
              details: auditDetails(input.reason, input.details),
            });
            return resolved;
          }),
        ),

      parkForApproval: (input) =>
        tx.run(
          Effect.gen(function* () {
            const approval = yield* approvals.create({
              tenantId: input.tenantId,
              caseId: input.caseId,
              agentId: input.agentId,
              tool: input.tool,
              proposedInput: input.proposedInput,
              reasoning: input.reasoning,
              riskLevel: input.riskLevel,
              expiresAt: input.expiresAt,
            });
            const row = yield* cases.transitionStatus(
              input.caseId,
              "waiting_for_approval",
              {
                tenantId: input.tenantId,
                reason: `tool ${input.tool} pending approval`,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              caseId: row.id,
              actor: { type: "agent", id: input.agentId },
              action: "case.waiting_for_approval",
              details: {
                approvalId: approval.id,
                tool: input.tool,
                turn: input.turn,
              },
            });
            return { approval, case_: row };
          }),
        ),

      parkWaitingForCustomer: (input) =>
        tx.run(
          Effect.gen(function* () {
            const updated = yield* cases.transitionStatus(
              input.caseId,
              "waiting_for_customer",
              {
                tenantId: input.tenantId,
                reason: input.tool,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "case.waiting_for_customer",
              details: { tool: input.tool, callId: input.callId },
            });
            return updated;
          }),
        ),

      parkWaitingForSupplier: (input) =>
        tx.run(
          Effect.gen(function* () {
            const updated = yield* cases.transitionStatus(
              input.caseId,
              "waiting_for_supplier",
              {
                tenantId: input.tenantId,
                reason: input.tool,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "case.waiting_for_supplier",
              details: { tool: input.tool, callId: input.callId },
            });
            return updated;
          }),
        ),

      reopenForCustomerReply: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases.getById(
              input.caseId,
              input.tenantId,
            );
            if (current.status !== "resolved") return current;
            const row = yield* cases.transitionStatus(
              current.id,
              "in_progress",
              {
                tenantId: current.tenantId,
                reason: `reopened by ${input.eventType}`,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              caseId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "case.reopened",
              details: { eventType: input.eventType },
            });
            return row;
          }),
        ),

      parkForReplyDeliveryFailure: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases.getById(
              input.caseId,
              input.tenantId,
            );
            const errorLabel = replyDeliveryErrorLabel(input.error);
            const draftId = replyDeliveryDraftId(
              current.id,
              input.tool,
              input.draftInput,
            );

            const replyDelivery = Option.getOrUndefined(maybeReplyDelivery);
            if (!replyDelivery) {
              yield* Effect.dieMessage("ReplyDeliveryService unavailable");
            } else {
              yield* replyDelivery.enqueue({
                tenantId: current.tenantId,
                caseId: current.id,
                agentId: input.agentId,
                tool: input.tool,
                mailbox: current.mailbox ?? null,
                draftId,
                draft: input.draftInput,
                error: errorLabel,
              });
            }

            const patchedContext = withRiskFlag(
              current.context,
              REPLY_DELIVERY_FAILED_FLAG,
            );
            if (patchedContext) {
              yield* cases.update(
                current.id,
                { context: patchedContext },
                current.tenantId,
              );
            }
            const row = yield* cases.transitionStatus(
              current.id,
              "human_takeover",
              {
                tenantId: current.tenantId,
                reason: REPLY_DELIVERY_FAILED_FLAG,
              },
            );
            yield* audit.record({
              tenantId: row.tenantId,
              caseId: row.id,
              actor: { type: "system", id: "agent-runtime" },
              action: "case.escalated_to_human",
              details: {
                reason: REPLY_DELIVERY_FAILED_FLAG,
                tool: input.tool,
                error: errorLabel,
              },
            });
            if (Option.isSome(maybeExecutions)) {
              yield* maybeExecutions.value.record({
                tenantId: current.tenantId,
                caseId: current.id,
                callId: input.executionKey,
                tool: input.tool,
                resultOk: false,
              });
            }
            return row;
          }),
        ),

      applyAgentStatusUpdate: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases.getById(
              input.caseId,
              input.tenantId,
            );
            const transitionOpts: {
              readonly tenantId: TenantId;
              readonly reason?: string;
              readonly expectedFromStatus?: CaseStatus;
            } = {
              tenantId: current.tenantId,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.expectedFromStatus !== undefined
                ? { expectedFromStatus: input.expectedFromStatus }
                : {}),
            };
            const updated = yield* cases.transitionStatus(
              current.id,
              input.toStatus,
              transitionOpts,
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: { type: "agent", id: input.agentId },
              action: "case.status_changed",
              details: {
                reason: input.reason ?? null,
                fromStatus: current.status,
                toStatus: input.toStatus,
                tool: input.tool,
                callId: input.callId,
              },
            });
            return updated;
          }),
        ),

      takeOver: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases
              .getById(input.caseId, input.tenantId)
              .pipe(
                Effect.map((case_) => ({ _tag: "found" as const, case_ })),
                Effect.catchTag("CaseNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "case_not_found" };
            const case_ = current.case_;
            if (TERMINAL_TAKEOVER_STATUSES.has(case_.status)) {
              return {
                kind: "already_terminal",
                status: case_.status,
              };
            }

            const updated = yield* cases.transitionStatus(
              case_.id,
              "human_takeover",
              {
                tenantId: case_.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: input.actor,
              action: "case.taken_over",
              details: {
                reason: input.reason,
                fromStatus: case_.status,
              },
            });
            const canceledApprovals = yield* approvals.cancelPendingForCase({
              tenantId: updated.tenantId,
              caseId: updated.id,
              decidedBy: input.decidedBy,
              decisionReason: "case taken over",
            });
            return { kind: "taken_over", canceledApprovals };
          }),
        ),

      resume: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases
              .getById(input.caseId, input.tenantId)
              .pipe(
                Effect.map((case_) => ({ _tag: "found" as const, case_ })),
                Effect.catchTag("CaseNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "case_not_found" };
            const case_ = current.case_;
            if (case_.status !== "human_takeover") {
              return { kind: "not_in_takeover", status: case_.status };
            }

            const updated = yield* cases.transitionStatus(
              case_.id,
              RESUME_TO_STATUS,
              {
                tenantId: case_.tenantId,
                expectedFromStatus: "human_takeover",
                reason: input.reason,
              },
            );
            // Full retry from triage: rebind to the primary agent and drop the
            // stale routing key so the tick re-classifies + re-routes. Same tx
            // as the status flip — the rebind must be atomic with the resume.
            if (input.restartFromTriage) {
              const { classification: _drop, ...keptContext } =
                case_.context as Record<string, unknown>;
              yield* cases.update(case_.id, {
                currentAgentId: PRIMARY_AGENT_ID,
                context: keptContext as never,
              });
            }
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: input.actor,
              action: "case.resumed",
              details: {
                reason: input.reason,
                fromStatus: case_.status,
                restartFromTriage: input.restartFromTriage === true,
              },
            });
            return { kind: "resumed", toStatus: RESUME_TO_STATUS };
          }),
        ),

      setMerchantStatus: (input) =>
        tx.run(
          Effect.gen(function* () {
            const current = yield* cases
              .getById(input.caseId, input.tenantId)
              .pipe(
                Effect.map((case_) => ({ _tag: "found" as const, case_ })),
                Effect.catchTag("CaseNotFound", () =>
                  Effect.succeed({ _tag: "missing" as const }),
                ),
              );
            if (current._tag === "missing") return { kind: "case_not_found" };
            const case_ = current.case_;
            if (!isMerchantSettableStatus(input.toStatus)) {
              return { kind: "invalid_status", status: input.toStatus };
            }
            const toStatus = input.toStatus;
            if (case_.status === toStatus) {
              return { kind: "unchanged", status: case_.status };
            }
            if (!isStatusTransitionAllowed(case_.status, toStatus)) {
              return {
                kind: "transition_not_allowed",
                fromStatus: case_.status,
                toStatus,
              };
            }

            const updated = yield* cases.transitionStatus(
              case_.id,
              toStatus,
              {
                tenantId: case_.tenantId,
                reason: input.reason,
              },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: input.actor,
              action: "case.status_changed",
              details: {
                reason: input.reason,
                fromStatus: case_.status,
                toStatus,
              },
            });
            const canceledApprovals = yield* approvals.cancelPendingForCase({
              tenantId: updated.tenantId,
              caseId: updated.id,
              decidedBy: input.decidedBy,
              decisionReason: "case status changed manually",
            });
            return {
              kind: "updated",
              fromStatus: case_.status,
              toStatus,
              canceledApprovals,
            };
          }),
        ),
    });
  }),
);
