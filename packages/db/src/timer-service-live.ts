import { Effect, FiberRef, Layer } from "effect";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
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
  CaseId as makeCaseId,
  type CaseId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { timers, type TimerRow } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const rowToTimer = (row: TimerRow): TimerRecord => ({
  id: row.id,
  caseId: makeCaseId(row.caseId),
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

    const schedule = (
      input: ScheduleTimerInput,
    ): Effect.Effect<TimerRecord, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "schedule",
          db
            .insert(timers)
            .values({
              id: randomUUID(),
              caseId: input.caseId,
              fireAt: input.fireAt,
              reason: input.reason,
            })
            .returning(),
        );
        return rowToTimer(rows[0]!);
      });

    const cancelOpenForCase = (
      caseId: CaseId,
      opts: CancelTimersOptions = {},
    ): Effect.Effect<number, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const now = opts?.now ?? new Date();
        const where = and(
          eq(timers.caseId, caseId),
          isNull(timers.firedAt),
          isNull(timers.cancelledAt),
          ...(opts?.reason ? [eq(timers.reason, opts.reason)] : []),
        );
        const rows = yield* wrap(
          "cancelOpenForCase",
          db
            .update(timers)
            .set({ cancelledAt: now })
            .where(where)
            .returning({ id: timers.id }),
        );
        return rows.length;
      });

    const fireDue = (
      now: Date,
      limit = 100,
    ): Effect.Effect<ReadonlyArray<TimerRecord>, TimerServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "fireDue",
          db.transaction(async (tx) => {
            const due = await tx
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
              .limit(limit);
            const ids = due.map((t) => t.id);
            if (ids.length === 0) return [];
            return tx
              .update(timers)
              .set({ firedAt: now })
              .where(inArray(timers.id, ids))
              .returning();
          }),
        );
        return rows.map(rowToTimer);
      });

    return TimerService.of({ schedule, cancelOpenForCase, fireDue });
  }),
);
