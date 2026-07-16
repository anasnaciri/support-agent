import { describe, expect, it } from "vitest";

import { analyticsPeriod, formatAnalyticsDuration } from "../lib/analytics";

describe("analytics period", () => {
  it("returns an exclusive UTC range for the selected trailing-day preset", () => {
    expect(
      analyticsPeriod(new Date("2026-07-16T14:32:18.000Z"), 30),
    ).toEqual({
      start: "2026-06-16T14:32:18.000Z",
      end: "2026-07-16T14:32:18.000Z",
    });
  });
});

describe("analytics duration formatting", () => {
  it("keeps operational timings compact and readable", () => {
    expect(formatAnalyticsDuration(null)).toBe("No data");
    expect(formatAnalyticsDuration(42)).toBe("42m");
    expect(formatAnalyticsDuration(150)).toBe("2h 30m");
    expect(formatAnalyticsDuration(3_180)).toBe("2d 5h");
  });
});
