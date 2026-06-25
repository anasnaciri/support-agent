import { describe, expect, it } from "vitest";

import {
  parsePercentage,
  parseMajorUnits,
  parseValidityDays,
  resolveDiscountThresholds,
} from "../app/settings/discount-policy/parse-discount";

describe("parsePercentage", () => {
  it("parses whole and two-decimal percentages in [0, 100]", () => {
    expect(parsePercentage("10")).toBe(10);
    expect(parsePercentage("12.5")).toBe(12.5);
    expect(parsePercentage("0")).toBe(0);
    expect(parsePercentage("100")).toBe(100);
  });

  it("rejects out-of-range / malformed input", () => {
    expect(parsePercentage("")).toBeNull();
    expect(parsePercentage("-5")).toBeNull();
    expect(parsePercentage("101")).toBeNull();
    expect(parsePercentage("12.345")).toBeNull();
    expect(parsePercentage("abc")).toBeNull();
  });
});

describe("parseValidityDays", () => {
  it("parses an integer in [1, 365]", () => {
    expect(parseValidityDays("30")).toBe(30);
    expect(parseValidityDays("1")).toBe(1);
    expect(parseValidityDays("365")).toBe(365);
  });

  it("rejects 0, negatives, decimals, and out-of-range", () => {
    expect(parseValidityDays("0")).toBeNull();
    expect(parseValidityDays("366")).toBeNull();
    expect(parseValidityDays("7.5")).toBeNull();
    expect(parseValidityDays("-1")).toBeNull();
    expect(parseValidityDays("")).toBeNull();
  });
});

describe("resolveDiscountThresholds", () => {
  const stored = { askPct: 10, maxPct: 20, askMinor: 0, maxMinor: 5000 };

  it("thresholds mode: parses every field and validates ordering", () => {
    expect(
      resolveDiscountThresholds({
        mode: "thresholds",
        askPctRaw: "5",
        maxPctRaw: "15",
        askAmtRaw: "2.00",
        maxAmtRaw: "30.00",
        stored,
      }),
    ).toEqual({ ok: true, askPct: 5, maxPct: 15, askMinor: 200, maxMinor: 3000 });
  });

  it("thresholds mode: bad percentage is an error", () => {
    expect(
      resolveDiscountThresholds({
        mode: "thresholds",
        askPctRaw: "x",
        maxPctRaw: "15",
        askAmtRaw: "2.00",
        maxAmtRaw: "30.00",
        stored,
      }),
    ).toEqual({ ok: false, error: "bad_percentage" });
  });

  it("thresholds mode: bad fixed amount is an error", () => {
    expect(
      resolveDiscountThresholds({
        mode: "thresholds",
        askPctRaw: "5",
        maxPctRaw: "15",
        askAmtRaw: "2.00",
        maxAmtRaw: "garbage",
        stored,
      }),
    ).toEqual({ ok: false, error: "bad_amount" });
  });

  it("thresholds mode: ask above max (either axis) is an ordering error", () => {
    expect(
      resolveDiscountThresholds({
        mode: "thresholds",
        askPctRaw: "20",
        maxPctRaw: "10",
        askAmtRaw: "2.00",
        maxAmtRaw: "30.00",
        stored,
      }),
    ).toEqual({ ok: false, error: "bad_order" });
  });

  it("non-threshold mode: valid input persists so switching back restores it", () => {
    expect(
      resolveDiscountThresholds({
        mode: "always_ask",
        askPctRaw: "8",
        maxPctRaw: "18",
        askAmtRaw: "1.00",
        maxAmtRaw: "40.00",
        stored,
      }),
    ).toEqual({ ok: true, askPct: 8, maxPct: 18, askMinor: 100, maxMinor: 4000 });
  });

  it("non-threshold mode: unparseable input keeps stored values per-field (no zeroing)", () => {
    expect(
      resolveDiscountThresholds({
        mode: "always_deny",
        askPctRaw: "",
        maxPctRaw: "garbage",
        askAmtRaw: "",
        maxAmtRaw: "x",
        stored,
      }),
    ).toEqual({ ok: true, askPct: 10, maxPct: 20, askMinor: 0, maxMinor: 5000 });
  });
});
