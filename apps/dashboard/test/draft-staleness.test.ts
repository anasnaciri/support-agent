import { describe, expect, it } from "vitest";
import { draftStaleness } from "../lib/draft-staleness";

describe("draftStaleness", () => {
  const now = new Date("2026-06-27T12:00:00.000Z");

  it("returns null for a fresh draft (< 24h)", () => {
    expect(
      draftStaleness(new Date("2026-06-27T00:00:01.000Z"), now),
    ).toBeNull();
  });

  it("flags a draft exactly 24h old as 1 day", () => {
    expect(draftStaleness(new Date("2026-06-26T12:00:00.000Z"), now)).toEqual({
      ageLabel: "1 day",
    });
  });

  it("pluralizes multi-day drafts", () => {
    expect(draftStaleness(new Date("2026-06-24T11:00:00.000Z"), now)).toEqual({
      ageLabel: "3 days",
    });
  });

  it("accepts an ISO string (Path B delivers dates as strings)", () => {
    expect(draftStaleness("2026-06-23T12:00:00.000Z", now)).toEqual({
      ageLabel: "4 days",
    });
  });

  it("returns null for an unparseable timestamp", () => {
    expect(draftStaleness("not-a-date", now)).toBeNull();
  });
});
