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
// REMIND: a pending approval's FIRST notification (approval email + merchant
// ping) is best-effort — a mail outage, a missing notificationEmail, or an
// unlinked chat channel can drop it, silently stranding the drafted reply in
// waiting_for_approval with nothing nudging the manager. This pass re-sends the
// SAME notification (via the runtime's shared builder) on a spaced cadence: a
// short grace so a reminder never races the first send, a daily interval, and a
// window after which it stops nagging (the dashboard stays the durable surface).
//
// NOTE: this cron used to ALSO time-expire overdue pending approvals and
// escalate their case to a human (audit L7). That was removed — approval
// drafts no longer expire by age for any tool; a parked approval waits
// for a human decision instead of being force-escalated. (The expiry
// sweep was also silently broken in prod: it interpolated a raw JS Date
// into a drizzle `sql` fragment, which throws and was swallowed.)

import { Effect, Option } from "effect";
import { randomUUID } from "node:crypto";
import {
  UserId,
  type Approval,
  type DomainEvent,
} from "@support-agent/agent-core";
import {
  ApprovalLinkConfig,
  ApprovalService,
  CaseRepository,
  MerchantNotificationService,
  PlatformMailService,
  buildApprovalNotification,
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

/**
 * Reminder cadence for still-pending approvals:
 *   - GRACE: don't re-notify within 30 min of creation — the initial
 *     notification already fired, and a dropped one is recovered on the first
 *     pass after this grace;
 *   - INTERVAL: at most one reminder per 24h thereafter;
 *   - WINDOW: stop reminding once the approval is older than 7 days.
 */
const REMINDER_GRACE_MS = 30 * 60_000;
const REMINDER_INTERVAL_MS = 24 * 60 * 60_000;
const REMINDER_WINDOW_MS = 7 * 24 * 60 * 60_000;

const WORKFLOW_QUEUE = "workflow.events";

/** Synthetic actor for events re-published by maintenance. */
const SYSTEM_MANAGER_ID = UserId("00000000-0000-0000-0000-000000000000");

export interface ApprovalMaintenanceOptions {
  readonly publish: (event: DomainEvent) => Promise<void>;
  /**
   * Re-send a still-pending approval's notification (email + merchant ping).
   * Injected so the pure sweep tests without standing up mail/merchant layers;
   * the register wiring builds the real sender from `runtimeLayer`. Best-effort:
   * a resolved promise (even one whose channels silently failed) stamps the row
   * so the interval gate spaces out the next reminder; a REJECTED promise leaves
   * the row unstamped so the next pass retries. Omit to skip the reminder pass.
   */
  readonly notify?: (approval: Approval) => Promise<void>;
  readonly now?: Date;
  readonly limit?: number;
}

export interface ApprovalMaintenanceResult {
  readonly republished: number;
  readonly reminded: number;
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

    // Remind. Re-notify still-pending approvals whose (best-effort) first
    // notification may have been dropped. Skipped when no notifier is wired.
    let reminded = 0;
    if (opts.notify) {
      const dueForReminder = yield* approvals
        .listPendingNeedingReminder({
          createdBefore: new Date(now.getTime() - REMINDER_GRACE_MS),
          createdAfter: new Date(now.getTime() - REMINDER_WINDOW_MS),
          remindedBefore: new Date(now.getTime() - REMINDER_INTERVAL_MS),
          limit,
        })
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError(
              `[approval-maintenance] listPendingNeedingReminder failed: ${String(error)}`,
            ).pipe(Effect.as([] as const)),
          ),
        );
      for (const approval of dueForReminder) {
        // Re-check the case is still parked on this approval — a race with a
        // just-decided case, or the in-memory Test layer, can over-return.
        const row = yield* cases
          .getById(approval.caseId, approval.tenantId)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!row || row.status !== "waiting_for_approval") continue;
        const sent = yield* Effect.tryPromise({
          try: () => opts.notify!(approval),
          catch: (cause) => cause,
        }).pipe(Effect.either);
        if (sent._tag === "Left") {
          // Leave the row unstamped so the next pass retries the reminder.
          yield* Effect.logError(
            `[approval-maintenance] reminder notify failed for approval=${approval.id}: ${String(sent.left)}`,
          );
          continue;
        }
        // Stamp so the interval gate spaces out the next reminder. A record
        // failure just means the reminder may re-fire next pass — harmless.
        yield* approvals
          .recordReminderSent(approval.id, now)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logError(
                `[approval-maintenance] recordReminderSent failed for approval=${approval.id}: ${String(error)}`,
              ),
            ),
          );
        reminded += 1;
      }
      if (reminded > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[approval-maintenance] re-notified ${reminded} pending approval(s)`,
        );
      }
    }

    return { republished, reminded };
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

/**
 * Real reminder sender: re-build the approval notification (shared with the
 * runtime's park-for-approval path, so links + preview never drift) and fan it
 * out on both channels. Every send is best-effort — the returned promise
 * resolves even when a channel is unconfigured or fails, so the sweep stamps
 * the row and spaces the next reminder; it rejects only on an unexpected error,
 * leaving the row unstamped to retry.
 */
const makeReminderNotifier =
  (runtimeLayer: WorkerBootstrap["runtimeLayer"]) =>
  (approval: Approval): Promise<void> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const linkConfig = yield* ApprovalLinkConfig;
          const mail = yield* PlatformMailService;
          const maybeNotifications = yield* Effect.serviceOption(
            MerchantNotificationService,
          );
          const notification = buildApprovalNotification({
            approvalId: approval.id,
            tenantId: approval.tenantId,
            caseId: approval.caseId,
            tool: approval.tool,
            proposedInput: approval.proposedInput,
            linkConfig,
          });
          yield* mail.sendApprovalLink(notification.mail).pipe(Effect.ignore);
          if (Option.isSome(maybeNotifications)) {
            yield* maybeNotifications.value
              .notify(approval.tenantId, notification.merchant)
              .pipe(Effect.ignore);
          }
        }),
        runtimeLayer,
      ),
    );

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
  const notify = makeReminderNotifier(opts.runtimeLayer);
  await opts.boss.work<Record<string, never>, void>(
    APPROVAL_MAINTENANCE_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const result = await Effect.runPromise(
          Effect.provide(
            runApprovalMaintenanceOnce({
              publish,
              notify,
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            }),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ApprovalMaintenanceResult> => {
                // eslint-disable-next-line no-console
                console.error("[approval-maintenance] pass crashed:", cause);
                return Effect.succeed({ republished: 0, reminded: 0 });
              },
            ),
          ),
        );
        if (result.republished > 0 || result.reminded > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[approval-maintenance] republished=${result.republished} reminded=${result.reminded}`,
          );
        }
      }
    },
  );
};
