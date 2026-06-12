import { describe, expect, it } from "vitest";
import { riskFlagLabel } from "../app/cases/[id]/risk-flag-label";

describe("riskFlagLabel", () => {
  it("humanises the duplicate-photo guard flag", () => {
    expect(riskFlagLabel("duplicate_photo_seen_in_case_abc")).toBe(
      "Duplicate photo seen on another case",
    );
  });

  it("humanises the refund customer-mismatch guard flag", () => {
    expect(riskFlagLabel("refund_customer_mismatch")).toBe(
      "Refund order belongs to a different customer",
    );
  });

  it("falls back to the raw flag for anything unknown", () => {
    expect(riskFlagLabel("some_future_flag")).toBe("some_future_flag");
  });
});
