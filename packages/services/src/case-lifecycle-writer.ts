import { Context, Effect, Layer } from "effect";
import {
  isMerchantSettableStatus,
  isStatusTransitionAllowed,
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
  | AuditLogError;

export class CaseLifecycleWriter extends Context.Tag("CaseLifecycleWriter")<
  CaseLifecycleWriter,
  {
    readonly escalateToHuman: (
      input: EscalateToHumanInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly resolve: (
      input: ResolveCaseInput,
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

const RESUME_TO_STATUS = "in_progress" satisfies CaseStatus;

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
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: input.actor,
              action: "case.resumed",
              details: {
                reason: input.reason,
                fromStatus: case_.status,
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
