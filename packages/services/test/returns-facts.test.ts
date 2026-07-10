import { describe, expect, it } from "vitest";
import {
  RETURNS_FACTS_MAX_WINDOW_DAYS,
  RETURNS_FACTS_TEXT_MAX,
  decodeReturnsFacts,
  type ReturnsFacts,
} from "../src/returns-facts.js";

const full: ReturnsFacts = {
  returnWindowDays: 30,
  returnShippingPayer: "customer",
  refundMethod: "original",
  refundProcessingTime: "5–7 business days after we receive the item",
};

describe("decodeReturnsFacts", () => {
  it("round-trips a fully populated block", () => {
    expect(decodeReturnsFacts({ ...full })).toEqual(full);
  });

  it("treats an unconfigured block as null", () => {
    // A tenant that never opened the form has no `returnsFacts` key at all.
    expect(decodeReturnsFacts(undefined)).toBeNull();
    expect(decodeReturnsFacts(null)).toBeNull();
    expect(decodeReturnsFacts("not an object")).toBeNull();
    expect(decodeReturnsFacts([])).toBeNull();
  });

  it("requires the return window — a block without it decodes to null", () => {
    // `returnWindowDays` is the one all-or-nothing field: the number a returns
    // scenario branches on. A block missing it is no facts block at all, which
    // sends the agent back to knowledge.search rather than to a made-up window.
    expect(decodeReturnsFacts({ ...full, returnWindowDays: null })).toBeNull();
    const { returnWindowDays: _omit, ...missing } = full;
    expect(decodeReturnsFacts(missing)).toBeNull();
  });

  it("rejects a return window that isn't a sane whole number of days", () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, "30", null]) {
      expect(decodeReturnsFacts({ ...full, returnWindowDays: bad })).toBeNull();
    }
  });

  it("clamps an absurd return window to the cap", () => {
    expect(
      decodeReturnsFacts({ ...full, returnWindowDays: 100_000 })
        ?.returnWindowDays,
    ).toBe(RETURNS_FACTS_MAX_WINDOW_DAYS);
  });

  it("keeps every optional field optional", () => {
    expect(decodeReturnsFacts({ returnWindowDays: 14 })).toEqual({
      returnWindowDays: 14,
      returnShippingPayer: null,
      refundMethod: null,
      refundProcessingTime: null,
    });
  });

  it("accepts each return-shipping payer", () => {
    for (const payer of ["customer", "merchant", "depends"] as const) {
      expect(
        decodeReturnsFacts({ ...full, returnShippingPayer: payer }),
      ).toEqual({ ...full, returnShippingPayer: payer });
    }
  });

  it("drops an unknown return-shipping payer instead of guessing one", () => {
    // Guessing "customer" here would have the agent tell a buyer they pay
    // return shipping the merchant actually covers.
    expect(
      decodeReturnsFacts({ ...full, returnShippingPayer: "someone" }),
    ).toEqual({ ...full, returnShippingPayer: null });
  });

  it("accepts each refund method", () => {
    for (const method of ["original", "store_credit", "customer_choice"] as const) {
      expect(decodeReturnsFacts({ ...full, refundMethod: method })).toEqual({
        ...full,
        refundMethod: method,
      });
    }
  });

  it("drops an unknown refund method instead of guessing one", () => {
    expect(decodeReturnsFacts({ ...full, refundMethod: "cash" })).toEqual({
      ...full,
      refundMethod: null,
    });
  });

  it("trims text and drops a blank optional to null", () => {
    const decoded = decodeReturnsFacts({
      ...full,
      refundProcessingTime: "   ",
    });
    expect(decoded?.refundProcessingTime).toBeNull();
    const trimmed = decodeReturnsFacts({
      ...full,
      refundProcessingTime: "  5–7 business days  ",
    });
    expect(trimmed?.refundProcessingTime).toBe("5–7 business days");
  });

  it("caps the free-text field rather than rejecting it", () => {
    const decoded = decodeReturnsFacts({
      ...full,
      refundProcessingTime: "x".repeat(RETURNS_FACTS_TEXT_MAX + 50),
    });
    expect(decoded?.refundProcessingTime).toHaveLength(RETURNS_FACTS_TEXT_MAX);
  });
});
