import { describe, expect, it } from "vitest";
import {
  ARCHIVED_CASE_DELETE_AFTER_MONTHS,
  RESOLVED_CASE_ARCHIVE_AFTER_DAYS,
  computeArchivedDeleteCutoff,
  computeResolvedArchiveCutoff,
} from "../src/retention-sweep.js";

describe("retention cutoffs", () => {
  it("archives resolved cases after 30 days", () => {
    const now = new Date("2026-05-24T12:00:00.000Z");
    expect(RESOLVED_CASE_ARCHIVE_AFTER_DAYS).toBe(30);
    const cutoff = computeResolvedArchiveCutoff(now);
    expect(cutoff.toISOString()).toBe("2026-04-24T12:00:00.000Z");
  });

  it("deletes archived cases after 12 calendar months", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    expect(ARCHIVED_CASE_DELETE_AFTER_MONTHS).toBe(12);
    const cutoff = computeArchivedDeleteCutoff(now);
    expect(cutoff.toISOString()).toBe("2025-05-24T00:00:00.000Z");
  });

  it("clamps calendar-month subtraction to the target month's final day", () => {
    const now = new Date("2026-03-31T00:00:00.000Z");
    expect(computeArchivedDeleteCutoff(now).toISOString()).toBe(
      "2025-03-31T00:00:00.000Z",
    );
  });
});
