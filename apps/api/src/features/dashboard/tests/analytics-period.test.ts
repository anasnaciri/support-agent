import { describe, expect, it } from "vitest";
import { parseAnalyticsPeriod } from "../analytics-period.js";

describe("parseAnalyticsPeriod", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it("defaults to the trailing 30 days", () => {
    expect(parseAnalyticsPeriod({}, now)).toEqual({
      ok: true,
      start: new Date("2026-06-16T12:00:00.000Z"),
      end: now,
    });
  });

  it("uses inclusive-start and exclusive-end bounds", () => {
    expect(
      parseAnalyticsPeriod(
        {
          start: "2026-07-01T00:00:00.000Z",
          end: "2026-07-15T00:00:00.000Z",
        },
        now,
      ),
    ).toEqual({
      ok: true,
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-15T00:00:00.000Z"),
    });
  });

  it("rejects invalid, reversed, and longer-than-one-year ranges", () => {
    expect(parseAnalyticsPeriod({ start: "not-a-date" }, now)).toEqual({
      ok: false,
      error: "invalid_analytics_period",
    });
    expect(
      parseAnalyticsPeriod(
        {
          start: "2026-07-15T00:00:00.000Z",
          end: "2026-07-01T00:00:00.000Z",
        },
        now,
      ),
    ).toEqual({ ok: false, error: "invalid_analytics_period" });
    expect(
      parseAnalyticsPeriod(
        {
          start: "2025-07-01T00:00:00.000Z",
          end: "2026-07-02T00:00:00.000Z",
        },
        now,
      ),
    ).toEqual({ ok: false, error: "analytics_period_too_large" });
  });
});
