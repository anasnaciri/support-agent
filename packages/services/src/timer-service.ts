import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import type { CaseId } from "@support-agent/agent-core";

export type TimerReason = "follow_up" | "sla" | "escalation";

export interface TimerRecord {
  readonly id: string;
  readonly caseId: CaseId;
  readonly fireAt: Date;
  readonly reason: TimerReason;
  readonly firedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface ScheduleTimerInput {
  readonly caseId: CaseId;
  readonly fireAt: Date;
  readonly reason: TimerReason;
}

export interface CancelTimersOptions {
  readonly reason?: TimerReason;
  readonly now?: Date;
}

export class TimerServiceDbError extends Data.TaggedError("TimerServiceDbError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type TimerServiceError = TimerServiceDbError;

export class TimerService extends Context.Tag("TimerService")<
  TimerService,
  {
    readonly schedule: (
      input: ScheduleTimerInput,
    ) => Effect.Effect<TimerRecord, TimerServiceError>;
    readonly cancelOpenForCase: (
      caseId: CaseId,
      opts?: CancelTimersOptions,
    ) => Effect.Effect<number, TimerServiceError>;
    readonly fireDue: (
      now: Date,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<TimerRecord>, TimerServiceError>;
  }
>() {}

export const TimerServiceTest = Layer.effect(
  TimerService,
  Effect.sync(() => {
    const timers: TimerRecord[] = [];

    return TimerService.of({
      schedule: (input) =>
        Effect.sync(() => {
          const timer: TimerRecord = {
            id: randomUUID(),
            caseId: input.caseId,
            fireAt: input.fireAt,
            reason: input.reason,
            firedAt: null,
            cancelledAt: null,
          };
          timers.push(timer);
          return timer;
        }),

      cancelOpenForCase: (caseId, opts = {}) =>
        Effect.sync(() => {
          const now = opts.now ?? new Date();
          let count = 0;
          for (let i = 0; i < timers.length; i += 1) {
            const timer = timers[i]!;
            if (timer.caseId !== caseId) continue;
            if (timer.firedAt || timer.cancelledAt) continue;
            if (opts.reason && timer.reason !== opts.reason) continue;
            timers[i] = { ...timer, cancelledAt: now };
            count += 1;
          }
          return count;
        }),

      fireDue: (now, limit = 100) =>
        Effect.sync(() => {
          const due: TimerRecord[] = [];
          for (let i = 0; i < timers.length; i += 1) {
            if (due.length >= limit) break;
            const timer = timers[i]!;
            if (timer.firedAt || timer.cancelledAt) continue;
            if (timer.fireAt.getTime() > now.getTime()) continue;
            const fired = { ...timer, firedAt: now };
            timers[i] = fired;
            due.push(fired);
          }
          return due;
        }),
    });
  }),
);
