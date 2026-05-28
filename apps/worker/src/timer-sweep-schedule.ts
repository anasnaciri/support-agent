// ============================================================
// Timer sweep cron — pg-boss schedule + workflow event publisher
// ============================================================
//
// The TimerService lives behind an Effect Tag; this file is only the
// worker-side pg-boss adapter that periodically turns due timer rows into
// durable `timer.expired` workflow events.

import { Effect } from "effect";
import type { DomainEvent } from "@support-agent/agent-core";
import {
  TimerService,
  type TimerRecord,
  type WorkflowEnqueueOptions,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import {
  enqueueWorkflowEvent,
  ensureWorkflowQueue,
} from "./workflow-queue-live.js";

export const TIMER_SWEEP_QUEUE = "timer.sweep";

/**
 * Cron expression: every minute. Timers are operational follow-ups and SLA
 * wakes, so minute-level granularity is enough while keeping queue churn low.
 */
const TIMER_SWEEP_CRON = "* * * * *";
const DEFAULT_LIMIT = 100;

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Override the cron expression — primarily for tests. */
  readonly cron?: string;
  /** Override batch size — primarily for tests and small local runs. */
  readonly limit?: number;
}

export const timerExpiredEventFor = (
  timer: TimerRecord,
): Extract<DomainEvent, { readonly type: "timer.expired" }> => ({
  type: "timer.expired",
  caseId: timer.caseId,
  timerId: timer.id,
  reason: timer.reason,
});

export const timerExpiredEventOptions = (
  timer: TimerRecord,
): WorkflowEnqueueOptions => ({
  eventId: timer.id,
  key: `case:${timer.caseId}`,
});

export const fireDueTimersOnce = (
  boss: PgBoss,
  now = new Date(),
  limit = DEFAULT_LIMIT,
) =>
  Effect.gen(function* () {
    const timers = yield* TimerService;
    const fired = yield* timers.fireDue(now, limit);
    for (const timer of fired) {
      yield* enqueueWorkflowEvent(
        boss,
        timerExpiredEventFor(timer),
        timerExpiredEventOptions(timer),
      );
    }
    return fired.length;
  });

export const registerTimerSweep = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(TIMER_SWEEP_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await Effect.runPromise(ensureWorkflowQueue(opts.boss));
  await opts.boss.schedule(
    TIMER_SWEEP_QUEUE,
    opts.cron ?? TIMER_SWEEP_CRON,
    {},
    { tz: "UTC" },
  );

  await opts.boss.work<Record<string, never>, void>(
    TIMER_SWEEP_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const count = await Effect.runPromise(
          Effect.provide(
            fireDueTimersOnce(opts.boss, new Date(), opts.limit),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause((cause): Effect.Effect<number> => {
              // eslint-disable-next-line no-console
              console.error("[timer-sweep] pass crashed:", cause);
              return Effect.succeed(0);
            }),
          ),
        );
        // eslint-disable-next-line no-console
        console.log(`[timer-sweep] pass complete: fired=${count}`);
      }
    },
  );
};
