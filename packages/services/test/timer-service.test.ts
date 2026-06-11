import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CaseId } from "@support-agent/agent-core";
import {
  TimerService,
  TimerServiceTest,
} from "../src/timer-service.js";

const run = <A, E>(eff: Effect.Effect<A, E, TimerService>) =>
  Effect.runPromise(Effect.provide(eff, TimerServiceTest));

describe("TimerService (Test layer)", () => {
  it("lists due timers without marking, then marks fired explicitly (audit L3a)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const timers = yield* TimerService;
        const timer = yield* timers.schedule({
          caseId: CaseId("case-1"),
          fireAt: new Date("2026-05-26T12:00:00.000Z"),
          reason: "follow_up",
        });
        const early = yield* timers.listDue(
          new Date("2026-05-26T11:59:00.000Z"),
        );
        const due = yield* timers.listDue(new Date("2026-05-26T12:00:00.000Z"));
        // listDue is a pure read — calling it again still returns the timer
        // (the sweep marks only after a successful enqueue).
        const stillDue = yield* timers.listDue(
          new Date("2026-05-26T12:01:00.000Z"),
        );
        yield* timers.markFired(timer.id, new Date("2026-05-26T12:01:00.000Z"));
        const afterMark = yield* timers.listDue(
          new Date("2026-05-26T12:02:00.000Z"),
        );
        return { timer, early, due, stillDue, afterMark };
      }),
    );

    expect(result.timer.firedAt).toBeNull();
    expect(result.early).toEqual([]);
    expect(result.due).toHaveLength(1);
    expect(result.due[0]?.id).toBe(result.timer.id);
    expect(result.stillDue).toHaveLength(1);
    expect(result.afterMark).toEqual([]);
  });

  it("cancels open timers for a case", async () => {
    const cancelled = await run(
      Effect.gen(function* () {
        const timers = yield* TimerService;
        yield* timers.schedule({
          caseId: CaseId("case-1"),
          fireAt: new Date("2026-05-26T12:00:00.000Z"),
          reason: "follow_up",
        });
        yield* timers.schedule({
          caseId: CaseId("case-1"),
          fireAt: new Date("2026-05-26T13:00:00.000Z"),
          reason: "sla",
        });
        return yield* timers.cancelOpenForCase(CaseId("case-1"), {
          reason: "follow_up",
          now: new Date("2026-05-26T11:00:00.000Z"),
        });
      }),
    );

    expect(cancelled).toBe(1);
  });
});
