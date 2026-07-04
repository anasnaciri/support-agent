import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import type { TicketId, TenantId } from "@support-agent/agent-core";

export type TimerReason = "follow_up" | "sla" | "escalation";

export interface TimerRecord {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly fireAt: Date;
  readonly reason: TimerReason;
  readonly firedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface ScheduleTimerInput {
  readonly ticketId: TicketId;
  readonly fireAt: Date;
  readonly reason: TimerReason;
  /**
   * Defense-in-depth tenant scope (audit D9): when present, scheduling
   * against a ticket outside the tenant fails instead of arming a timer on a
   * foreign ticket. Timers carry no tenant column — the check goes through
   * the ticket row.
   */
  readonly tenantId?: TenantId;
}

export interface CancelTimersOptions {
  readonly reason?: TimerReason;
  readonly now?: Date;
  /** See {@link ScheduleTimerInput.tenantId} (audit D9). */
  readonly tenantId?: TenantId;
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
    readonly cancelOpenForTicket: (
      ticketId: TicketId,
      opts?: CancelTimersOptions,
    ) => Effect.Effect<number, TimerServiceError>;
    /**
     * Due, unfired, uncancelled timers — WITHOUT marking them (audit
     * L3a). The sweep enqueues each timer's event first and only then
     * calls `markFired`; the old single-shot claim-and-mark meant a
     * crash or enqueue failure after the mark silently dropped the
     * wake-up forever.
     */
    readonly listDue: (
      now: Date,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<TimerRecord>, TimerServiceError>;
    /** Stamp `firedAt` after the timer's event was durably enqueued. */
    readonly markFired: (
      timerId: string,
      firedAt: Date,
    ) => Effect.Effect<void, TimerServiceError>;
  }
>() {}

export const TimerServiceTest = Layer.effect(
  TimerService,
  Effect.sync(() => {
    const timers: TimerRecord[] = [];
    // D9: the in-memory layer has no ticket table to check tenancy against, so
    // it records the tenant given at schedule time and enforces it on cancel.
    const tenantOf = new Map<string, TenantId>();

    return TimerService.of({
      schedule: (input) =>
        Effect.sync(() => {
          const timer: TimerRecord = {
            id: randomUUID(),
            ticketId: input.ticketId,
            fireAt: input.fireAt,
            reason: input.reason,
            firedAt: null,
            cancelledAt: null,
          };
          timers.push(timer);
          if (input.tenantId !== undefined) {
            tenantOf.set(timer.id, input.tenantId);
          }
          return timer;
        }),

      cancelOpenForTicket: (ticketId, opts = {}) =>
        Effect.sync(() => {
          const now = opts.now ?? new Date();
          let count = 0;
          for (let i = 0; i < timers.length; i += 1) {
            const timer = timers[i]!;
            if (timer.ticketId !== ticketId) continue;
            if (timer.firedAt || timer.cancelledAt) continue;
            if (opts.reason && timer.reason !== opts.reason) continue;
            if (opts.tenantId !== undefined) {
              const owner = tenantOf.get(timer.id);
              if (owner !== undefined && owner !== opts.tenantId) continue;
            }
            timers[i] = { ...timer, cancelledAt: now };
            count += 1;
          }
          return count;
        }),

      listDue: (now, limit = 100) =>
        Effect.sync(() => {
          const due: TimerRecord[] = [];
          for (const timer of timers) {
            if (due.length >= limit) break;
            if (timer.firedAt || timer.cancelledAt) continue;
            if (timer.fireAt.getTime() > now.getTime()) continue;
            due.push(timer);
          }
          return due;
        }),

      markFired: (timerId, firedAt) =>
        Effect.sync(() => {
          for (let i = 0; i < timers.length; i += 1) {
            const timer = timers[i]!;
            if (timer.id === timerId && !timer.firedAt) {
              timers[i] = { ...timer, firedAt };
            }
          }
        }),
    });
  }),
);
