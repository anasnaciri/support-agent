import { describe, expect, it } from "vitest";
import { computeCutoff } from "../src/retention-sweep.js";

describe("computeCutoff", () => {
  it("subtracts N days from the reference time", () => {
    const now = new Date("2026-05-24T12:00:00.000Z");
    const cutoff = computeCutoff(now, 30);
    expect(cutoff.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });

  it("handles the default 24-month retention (730 days)", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    const cutoff = computeCutoff(now, 730);
    // 730 days back from 2026-05-24 lands on 2024-05-24.
    expect(cutoff.toISOString()).toBe("2024-05-24T00:00:00.000Z");
  });

  it("is pure — same inputs always produce same output", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(computeCutoff(now, 7).toISOString()).toBe(
      computeCutoff(now, 7).toISOString(),
    );
  });
});
