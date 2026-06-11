import { describe, expect, it } from "vitest";

import {
  PAUSE_AFTER_FAILURES,
  isPaused,
  nextFailureCount,
} from "../app/cases/[id]/live-status";

// U11: a single blip keeps the quiet amber dot, but after N consecutive
// failures the boundary shows visible "Updates paused" text. A success
// resets the streak.
describe("nextFailureCount", () => {
  it("increments on failure", () => {
    expect(nextFailureCount(0, false)).toBe(1);
    expect(nextFailureCount(2, false)).toBe(3);
  });

  it("resets to zero on success", () => {
    expect(nextFailureCount(5, true)).toBe(0);
  });
});

describe("isPaused", () => {
  it("stays quiet below the threshold", () => {
    expect(isPaused(0)).toBe(false);
    expect(isPaused(PAUSE_AFTER_FAILURES - 1)).toBe(false);
  });

  it("pauses at and beyond the threshold", () => {
    expect(isPaused(PAUSE_AFTER_FAILURES)).toBe(true);
    expect(isPaused(PAUSE_AFTER_FAILURES + 3)).toBe(true);
  });
});
