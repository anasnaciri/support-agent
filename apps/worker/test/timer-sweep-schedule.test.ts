import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CaseId, TenantId } from "@support-agent/agent-core";
import {
  TimerService,
  TimerServiceTest,
  type TimerRecord,
} from "@support-agent/services";
import type { PgBoss } from "../src/queue.js";
import {
  fireDueTimersOnce,
  timerExpiredEventFor,
  timerExpiredEventOptions,
} from "../src/timer-sweep-schedule.js";

describe("timer sweep schedule helpers", () => {
  const timer: TimerRecord = {
    id: "timer-123",
    caseId: CaseId("case-123"),
    fireAt: new Date("2026-05-27T10:00:00.000Z"),
    reason: "follow_up",
    firedAt: new Date("2026-05-27T10:01:00.000Z"),
    cancelledAt: null,
  };

  it("maps a fired timer to a timer.expired workflow event", () => {
    expect(timerExpiredEventFor(timer)).toEqual({
      type: "timer.expired",
      caseId: CaseId("case-123"),
      timerId: "timer-123",
      reason: "follow_up",
    });
  });

  it("uses the timer id as the event id and serializes by case", () => {
    expect(timerExpiredEventOptions(timer)).toEqual({
      eventId: "timer-123",
      key: "case:case-123",
    });
  });
});

// Audit L3a — the sweep previously marked timers fired and THEN
// enqueued; a crash or enqueue failure between the two silently dropped
// the wake-up forever. The order is now enqueue-then-mark: a duplicate
// timer.expired is harmless (the runtime's guards absorb it), a lost one
// is not.
describe("fireDueTimersOnce — enqueue-then-mark (audit L3a)", () => {
  const scheduleDue = Effect.gen(function* () {
    const timers = yield* TimerService;
    return yield* timers.schedule({
      caseId: CaseId("case-l3a"),
      tenantId: TenantId("tenant-acme"),
      fireAt: new Date(Date.now() - 60_000),
      reason: "follow_up",
    });
  });

  const bossStub = (behavior: "ok" | "fail"): PgBoss =>
    ({
      send: async () => {
        if (behavior === "fail") throw new Error("pg-boss down");
        return "job-1";
      },
      createQueue: async () => {},
    }) as unknown as PgBoss;

  it("does NOT mark a timer fired when its enqueue fails — the next pass retries it", async () => {
    const layer = TimerServiceTest;
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* scheduleDue;
          const fired = yield* fireDueTimersOnce(
            bossStub("fail"),
            new Date(),
            10,
          ).pipe(Effect.either);
          // Second pass with a healthy boss must still see the timer.
          const second = yield* fireDueTimersOnce(
            bossStub("ok"),
            new Date(),
            10,
          );
          return { fired, second };
        }),
        layer,
      ) as Effect.Effect<
        { fired: unknown; second: number },
        never,
        never
      >,
    );
    expect(out.second).toBe(1);
  });

  it("marks timers fired after a successful enqueue (no duplicates next pass)", async () => {
    const layer = TimerServiceTest;
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* scheduleDue;
          const first = yield* fireDueTimersOnce(
            bossStub("ok"),
            new Date(),
            10,
          );
          const second = yield* fireDueTimersOnce(
            bossStub("ok"),
            new Date(),
            10,
          );
          return { first, second };
        }),
        layer,
      ) as Effect.Effect<{ first: number; second: number }, never, never>,
    );
    expect(out.first).toBe(1);
    expect(out.second).toBe(0);
  });
});
