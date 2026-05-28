import { describe, expect, it } from "vitest";
import { CaseId } from "@support-agent/agent-core";
import type { TimerRecord } from "@support-agent/services";
import {
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
