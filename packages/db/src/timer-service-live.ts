import { Effect, FiberRef, Layer } from "effect";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  TimerService,
  TimerServiceDbError,
  type CancelTimersOptions,
  type ScheduleTimerInput,
  type TimerRecord,
  type TimerReason,
  type TimerServiceError,
} from "@support-agent/services";
import {
  TicketId as makeTicketId,
  type TicketId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { tickets, timers, type TimerRow } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const rowToTimer = (row: TimerRow): TimerRecord => ({
  id: row.id,
  ticketId: makeTicketId(row.ticketId),
  fireAt: row.fireAt,
  reason: row.reason as TimerReason,
  firedAt: row.firedAt,
  cancelledAt: row.cancelledAt,
});

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, TimerServiceDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new TimerServiceDbError({ operation, cause }),
  });

export const TimerServiceLive = Layer.effect(
  TimerService,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    // D9: timers carry no tenant column — tenancy is checked through the
    // ticket row. A ticket outside the given tenant reads as missing.
    const ticketInTenant = (ticketId: TicketId, tenantId: string) =>
      sql`EXISTS (SELECT 1 FROM ${tickets} WHERE ${tickets.id} = ${ticketId} AND ${tickets.tenantId} = ${tenantId})`;

    const schedule = (
      input: ScheduleTimerInput,
    ): Effect.Effect<TimerRecord, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        if (input.tenantId !== undefined) {
          const owned = yield* wrap(
            "schedule",
            db
              .select({ id: tickets.id })
              .from(tickets)
              .where(
                and(
                  eq(tickets.id, input.ticketId),
                  eq(tickets.tenantId, input.tenantId),
                ),
              )
              .limit(1),
          );
          if (owned.length === 0) {
            return yield* Effect.fail(
              new TimerServiceDbError({
                operation: "schedule",
                cause: `ticket ${input.ticketId} not found in tenant ${input.tenantId}`,
              }),
            );
          }
        }
        const rows = yield* wrap(
          "schedule",
          db
            .insert(timers)
            .values({
              id: randomUUID(),
              ticketId: input.ticketId,
              fireAt: input.fireAt,
              reason: input.reason,
            })
            .returning(),
        );
        return rowToTimer(rows[0]!);
      });

    const cancelOpenForTicket = (
      ticketId: TicketId,
      opts: CancelTimersOptions = {},
    ): Effect.Effect<number, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const now = opts?.now ?? new Date();
        const where = and(
          eq(timers.ticketId, ticketId),
          isNull(timers.firedAt),
          isNull(timers.cancelledAt),
          ...(opts?.reason ? [eq(timers.reason, opts.reason)] : []),
          ...(opts?.tenantId !== undefined
            ? [ticketInTenant(ticketId, opts.tenantId)]
            : []),
        );
        const rows = yield* wrap(
          "cancelOpenForTicket",
          db
            .update(timers)
            .set({ cancelledAt: now })
            .where(where)
            .returning({ id: timers.id }),
        );
        return rows.length;
      });

    // Audit L3a: list-then-mark instead of claim-and-mark. The sweep
    // enqueues each timer's event before `markFired`; duplicates across
    // racing sweep passes are absorbed downstream (ticket-keyed FIFO + the
    // runtime's guards), while a lost wake-up never recovers.
    const listDue = (
      now: Date,
      limit = 100,
    ): Effect.Effect<ReadonlyArray<TimerRecord>, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listDue",
          db
            .select()
            .from(timers)
            .where(
              and(
                lte(timers.fireAt, now),
                isNull(timers.firedAt),
                isNull(timers.cancelledAt),
              ),
            )
            .orderBy(asc(timers.fireAt), asc(timers.id))
            .limit(limit),
        );
        return rows.map(rowToTimer);
      });

    const markFired = (
      timerId: string,
      firedAt: Date,
    ): Effect.Effect<void, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        // CAS on firedAt IS NULL: a concurrent sweep that already marked
        // the timer is a no-op here.
        yield* wrap(
          "markFired",
          db
            .update(timers)
            .set({ firedAt })
            .where(and(eq(timers.id, timerId), isNull(timers.firedAt))),
        );
      });

    return TimerService.of({ schedule, cancelOpenForTicket, listDue, markFired });
  }),
);
