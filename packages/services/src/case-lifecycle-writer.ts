import { Context, Effect, Layer } from "effect";
import type {
  Case,
  CaseContext,
  CaseId,
  CaseStatus,
  TenantId,
} from "@support-agent/agent-core";
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

export type CaseLifecycleWriterError = CaseRepositoryError | AuditLogError;

export class CaseLifecycleWriter extends Context.Tag("CaseLifecycleWriter")<
  CaseLifecycleWriter,
  {
    readonly escalateToHuman: (
      input: EscalateToHumanInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;

    readonly resolve: (
      input: ResolveCaseInput,
    ) => Effect.Effect<Case, CaseLifecycleWriterError>;
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

export const CaseLifecycleWriterLive = Layer.effect(
  CaseLifecycleWriter,
  Effect.gen(function* () {
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
    });
  }),
);
