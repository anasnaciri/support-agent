// ============================================================
// Approvals maintenance cron (audit L7 sweep + L3b)
// ============================================================
//
// Two recovery loops the approval flow needs to be safe under partial
// failure:
//
//   1. EXPIRY (L7): pending approvals past `expiresAt` flip to `expired`
//      and their case escalates to a human. Without this the `expired`
//      status was unreachable and a never-clicked approval left its case
//      parked in `waiting_for_approval` forever.
//
//   2. REPUBLISH (L3b): an approval can be decided (row committed) while
//      the matching workflow event publish fails — the case then stays
//      parked even though the manager already said yes/no. Re-publish the
//      event for decided approvals whose case is still parked after a
//      grace window; the runtime's resume guards make re-delivery
//      idempotent.

import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  UserId,
  type DomainEvent,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  AuditLogService,
  CaseRepository,
  TransactionRunner,
  makeEnqueuedWorkflowEvent,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const APPROVAL_MAINTENANCE_QUEUE = "approval.maintenance";

/** Every 2 minutes — approvals are human-latency objects. */
const APPROVAL_MAINTENANCE_CRON = "*/2 * * * *";
const DEFAULT_LIMIT = 100;
/** Grace before treating a decided-but-parked case as a lost publish. */
const REPUBLISH_GRACE_MS = 2 * 60_000;

const WORKFLOW_QUEUE = "workflow.events";

/** Synthetic actor for events re-published by maintenance. */
const SYSTEM_MANAGER_ID = UserId("00000000-0000-0000-0000-000000000000");

export interface ApprovalMaintenanceOptions {
  readonly publish: (event: DomainEvent) => Promise<void>;
  readonly now?: Date;
  readonly limit?: number;
}

export interface ApprovalMaintenanceResult {
  readonly expired: number;
  readonly republished: number;
}

export const runApprovalMaintenanceOnce = (
  opts: ApprovalMaintenanceOptions,
): Effect.Effect<
  ApprovalMaintenanceResult,
  never,
  ApprovalService | CaseRepository | AuditLogService | TransactionRunner
> =>
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const tx = yield* TransactionRunner;
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? DEFAULT_LIMIT;

    // 1. Expiry (L7).
    const expiredRows = yield* approvals
      .expireOverdue(now, limit)
      .pipe(Effect.catchAll(() => Effect.succeed([] as const)));
    let expired = 0;
    for (const approval of expiredRows) {
      expired += 1;
      // Park the case for a human — but only when it is still waiting on
      // this approval; anything else means the case moved on already.
      yield* tx
        .run(
          Effect.gen(function* () {
            const row = yield* cases.getById(
              approval.caseId,
              approval.tenantId,
            );
            if (row.status !== "waiting_for_approval") return;
            const updated = yield* cases.transitionStatus(
              row.id,
              "human_takeover",
              { reason: "approval_expired", tenantId: approval.tenantId },
            );
            yield* audit.record({
              tenantId: updated.tenantId,
              caseId: updated.id,
              actor: { type: "system", id: "approval-maintenance" },
              action: "case.escalated_to_human",
              details: {
                reason: "approval_expired",
                approvalId: approval.id,
                expiresAt: approval.expiresAt.toISOString(),
              },
            });
          }),
        )
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(
              `[approval-maintenance] failed to escalate case ${approval.caseId}: ${String(cause)}`,
            ),
          ),
        );
    }

    // 2. Republish (L3b).
    const decidedUnresumed = yield* approvals
      .listDecidedUnresumed({
        decidedBefore: new Date(now.getTime() - REPUBLISH_GRACE_MS),
        limit,
      })
      .pipe(Effect.catchAll(() => Effect.succeed([] as const)));
    let republished = 0;
    for (const approval of decidedUnresumed) {
      // Re-check the case status — the in-memory Test layer over-returns,
      // and even the SQL join can race a just-resumed case.
      const row = yield* cases
        .getById(approval.caseId, approval.tenantId)
        .pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (!row || row.status !== "waiting_for_approval") continue;
      const event: DomainEvent =
        approval.status === "approved"
          ? {
              type: "approval.approved",
              approvalId: approval.id,
              caseId: approval.caseId,
              managerId: approval.decidedBy ?? SYSTEM_MANAGER_ID,
            }
          : {
              type: "approval.rejected",
              approvalId: approval.id,
              caseId: approval.caseId,
              managerId: approval.decidedBy ?? SYSTEM_MANAGER_ID,
            };
      const sent = yield* Effect.tryPromise({
        try: () => opts.publish(event),
        catch: (cause) => cause,
      }).pipe(Effect.either);
      if (sent._tag === "Left") {
        yield* Effect.logError(
          `[approval-maintenance] republish failed for approval=${approval.id}: ${String(sent.left)}`,
        );
        continue;
      }
      republished += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[approval-maintenance] republished ${event.type} for approval=${approval.id} case=${approval.caseId} (decision event was lost)`,
      );
    }

    return { expired, republished };
  });

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  readonly cron?: string;
  readonly limit?: number;
}

const makePublisher =
  (boss: PgBoss) =>
  async (event: DomainEvent): Promise<void> => {
    const enqueued = makeEnqueuedWorkflowEvent(event, {
      eventId: randomUUID(),
    });
    await boss.send(
      WORKFLOW_QUEUE,
      {
        eventId: enqueued.eventId,
        event: enqueued.event,
        key: enqueued.key,
        enqueuedAt: enqueued.enqueuedAt.toISOString(),
      },
      { singletonKey: enqueued.key },
    );
  };

export const registerApprovalMaintenance = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(APPROVAL_MAINTENANCE_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    APPROVAL_MAINTENANCE_QUEUE,
    opts.cron ?? APPROVAL_MAINTENANCE_CRON,
    {},
    { tz: "UTC" },
  );

  const publish = makePublisher(opts.boss);
  await opts.boss.work<Record<string, never>, void>(
    APPROVAL_MAINTENANCE_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const result = await Effect.runPromise(
          Effect.provide(
            runApprovalMaintenanceOnce({
              publish,
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            }),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ApprovalMaintenanceResult> => {
                // eslint-disable-next-line no-console
                console.error("[approval-maintenance] pass crashed:", cause);
                return Effect.succeed({ expired: 0, republished: 0 });
              },
            ),
          ),
        );
        if (result.expired > 0 || result.republished > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[approval-maintenance] expired=${result.expired} republished=${result.republished}`,
          );
        }
      }
    },
  );
};
