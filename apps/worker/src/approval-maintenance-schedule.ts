// ============================================================
// Approvals maintenance cron (audit L3b)
// ============================================================
//
// REPUBLISH (L3b): an approval can be decided (row committed) while the
// matching workflow event publish fails — the case then stays parked
// even though the manager already said yes/no. Re-publish the event for
// decided approvals whose case is still parked after a grace window; the
// runtime's resume guards make re-delivery idempotent.
//
// NOTE: this cron used to ALSO time-expire overdue pending approvals and
// escalate their case to a human (audit L7). That was removed — approval
// drafts no longer expire by age for any tool; a parked approval waits
// for a human decision instead of being force-escalated. (The expiry
// sweep was also silently broken in prod: it interpolated a raw JS Date
// into a drizzle `sql` fragment, which throws and was swallowed.)

import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  UserId,
  type DomainEvent,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  CaseRepository,
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
  readonly republished: number;
}

export const runApprovalMaintenanceOnce = (
  opts: ApprovalMaintenanceOptions,
): Effect.Effect<
  ApprovalMaintenanceResult,
  never,
  ApprovalService | CaseRepository
> =>
  Effect.gen(function* () {
    const approvals = yield* ApprovalService;
    const cases = yield* CaseRepository;
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? DEFAULT_LIMIT;

    // Republish (L3b). Decided rows whose case never resumed because the
    // workflow event was lost between decision-commit and publish.
    const decidedUnresumed = yield* approvals
      .listDecidedUnresumed({
        decidedBefore: new Date(now.getTime() - REPUBLISH_GRACE_MS),
        limit,
      })
      .pipe(
        // Never swallow silently: a masked DB error here is exactly what
        // hid the broken date-comparison sweep in prod for 10 days.
        Effect.catchAll((error) =>
          Effect.logError(
            `[approval-maintenance] listDecidedUnresumed failed: ${String(error)}`,
          ).pipe(Effect.as([] as const)),
        ),
      );
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

    return { republished };
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
                return Effect.succeed({ republished: 0 });
              },
            ),
          ),
        );
        if (result.republished > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[approval-maintenance] republished=${result.republished}`,
          );
        }
      }
    },
  );
};
