import { describe, expect, it } from "vitest";

import { nextOptionIndex } from "../lib/multi-select-nav";

// U13: ArrowUp/ArrowDown roving focus between MultiSelect options.
describe("nextOptionIndex", () => {
  it("moves down from an option", () => {
    expect(nextOptionIndex(0, 1, 4)).toBe(1);
    expect(nextOptionIndex(2, 1, 4)).toBe(3);
  });

  it("moves up from an option", () => {
    expect(nextOptionIndex(2, -1, 4)).toBe(1);
  });

  it("clamps at the ends (no wrap)", () => {
    expect(nextOptionIndex(3, 1, 4)).toBe(3);
    expect(nextOptionIndex(0, -1, 4)).toBe(0);
  });

  it("enters the list at the right end when nothing is focused yet", () => {
    // ArrowDown from the trigger → first option; ArrowUp → last option.
    expect(nextOptionIndex(-1, 1, 4)).toBe(0);
    expect(nextOptionIndex(-1, -1, 4)).toBe(3);
  });

  it("returns -1 for an empty list", () => {
    expect(nextOptionIndex(-1, 1, 0)).toBe(-1);
  });
});
