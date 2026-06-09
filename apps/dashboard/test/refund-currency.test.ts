import { describe, expect, it } from "vitest";

import { refundCurrencyMismatch } from "../lib/refund-currency";

describe("refundCurrencyMismatch", () => {
  it("warns when the policy currency differs from the store, in thresholds mode", () => {
    expect(refundCurrencyMismatch("USD", "EUR", "thresholds")).toBe(true);
  });

  it("does not warn when they match (case/space-insensitive)", () => {
    expect(refundCurrencyMismatch("USD", "USD", "thresholds")).toBe(false);
    expect(refundCurrencyMismatch("usd", " USD ", "thresholds")).toBe(false);
  });

  it("never warns when the store currency is unknown", () => {
    expect(refundCurrencyMismatch("USD", null, "thresholds")).toBe(false);
    expect(refundCurrencyMismatch("USD", "", "thresholds")).toBe(false);
  });

  it("never warns outside thresholds mode (currency is irrelevant there)", () => {
    expect(refundCurrencyMismatch("USD", "EUR", "always_ask")).toBe(false);
    expect(refundCurrencyMismatch("USD", "EUR", "always_deny")).toBe(false);
  });
});
