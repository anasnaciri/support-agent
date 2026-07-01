import { describe, expect, it } from "vitest";

import {
  parseMajorUnits,
  resolveRefundThresholds,
} from "../lib/parse-thresholds";

describe("parseMajorUnits", () => {
  it("parses whole and two-decimal amounts into minor units", () => {
    expect(parseMajorUnits("200")).toBe(20000);
    expect(parseMajorUnits("25.00")).toBe(2500);
    expect(parseMajorUnits("0.5")).toBe(50);
  });

  it("rejects malformed input", () => {
    expect(parseMajorUnits("")).toBeNull();
    expect(parseMajorUnits("abc")).toBeNull();
    expect(parseMajorUnits("-5")).toBeNull();
    expect(parseMajorUnits("1.234")).toBeNull();
    expect(parseMajorUnits("1.2.3")).toBeNull();
  });
});

// U10: in always_ask / always_deny mode the threshold inputs are hidden
// mirrors; a stale tab or garbage value must NOT silently zero the stored
// thresholds. Unparseable input falls back to the stored value instead.
describe("resolveRefundThresholds", () => {
  const stored = { askMinor: 2500, denyMinor: 20000 };

  it("thresholds mode: parses both and validates ordering", () => {
    expect(
      resolveRefundThresholds({ mode: "thresholds", askRaw: "10", denyRaw: "50", stored }),
    ).toEqual({ ok: true, askMinor: 1000, denyMinor: 5000 });
  });

  it("thresholds mode: unparseable input is an error (never coalesced)", () => {
    expect(
      resolveRefundThresholds({ mode: "thresholds", askRaw: "x", denyRaw: "50", stored }),
    ).toEqual({ ok: false, error: "bad_amount" });
  });

  it("thresholds mode: ask above deny is an error", () => {
    expect(
      resolveRefundThresholds({ mode: "thresholds", askRaw: "60", denyRaw: "50", stored }),
    ).toEqual({ ok: false, error: "bad_order" });
  });

  it("non-threshold mode: valid input is persisted so switching back restores it", () => {
    expect(
      resolveRefundThresholds({ mode: "always_ask", askRaw: "10", denyRaw: "50", stored }),
    ).toEqual({ ok: true, askMinor: 1000, denyMinor: 5000 });
  });

  it("non-threshold mode: unparseable input keeps the stored values (no zeroing)", () => {
    expect(
      resolveRefundThresholds({ mode: "always_deny", askRaw: "", denyRaw: "garbage", stored }),
    ).toEqual({ ok: true, askMinor: 2500, denyMinor: 20000 });
  });

  it("non-threshold mode: falls back per-field, not all-or-nothing", () => {
    expect(
      resolveRefundThresholds({ mode: "always_ask", askRaw: "12", denyRaw: "", stored }),
    ).toEqual({ ok: true, askMinor: 1200, denyMinor: 20000 });
  });

  it("non-threshold mode: ordering is not enforced (thresholds are dormant)", () => {
    expect(
      resolveRefundThresholds({ mode: "always_ask", askRaw: "60", denyRaw: "50", stored }),
    ).toEqual({ ok: true, askMinor: 6000, denyMinor: 5000 });
  });
});
