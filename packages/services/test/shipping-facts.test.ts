import { describe, expect, it } from "vitest";
import {
  SHIPPING_FACTS_MAX_DELAY_DAYS,
  SHIPPING_FACTS_TEXT_MAX,
  decodeShippingFacts,
  type ShippingFacts,
} from "../src/shipping-facts.js";

const full: ShippingFacts = {
  processingTime: "1–2 business days",
  deliveryTime: "7–12 days",
  shippingCost: "Free over $50, otherwise $4.95",
  customsDuties: "customer",
  delayedAfterDays: 14,
  lostPackageInvestigationDays: 30,
};

describe("decodeShippingFacts", () => {
  it("round-trips a fully populated profile", () => {
    expect(decodeShippingFacts({ ...full })).toEqual(full);
  });

  it("treats an unconfigured profile as null", () => {
    // A tenant that never opened the form has no `shippingFacts` key at all.
    expect(decodeShippingFacts(undefined)).toBeNull();
    expect(decodeShippingFacts(null)).toBeNull();
    expect(decodeShippingFacts("not an object")).toBeNull();
    expect(decodeShippingFacts([])).toBeNull();
  });

  it("requires the three starred fields — a partial block decodes to null", () => {
    // Defaults-on-read must never invent a delivery window or a delay
    // threshold: a half-written block is no profile at all, which sends the
    // agent back to knowledge.search rather than to a made-up number.
    expect(decodeShippingFacts({ ...full, processingTime: "" })).toBeNull();
    expect(decodeShippingFacts({ ...full, deliveryTime: "   " })).toBeNull();
    expect(decodeShippingFacts({ ...full, delayedAfterDays: null })).toBeNull();
    const { deliveryTime: _omit, ...missing } = full;
    expect(decodeShippingFacts(missing)).toBeNull();
  });

  it("keeps the optional fields optional", () => {
    expect(
      decodeShippingFacts({
        processingTime: "1 day",
        deliveryTime: "5 days",
        delayedAfterDays: 10,
      }),
    ).toEqual({
      processingTime: "1 day",
      deliveryTime: "5 days",
      shippingCost: null,
      customsDuties: null,
      delayedAfterDays: 10,
      lostPackageInvestigationDays: null,
    });
  });

  it("trims text and drops a blank optional to null", () => {
    const decoded = decodeShippingFacts({
      ...full,
      processingTime: "  1–2 business days  ",
      shippingCost: "   ",
    });
    expect(decoded?.processingTime).toBe("1–2 business days");
    expect(decoded?.shippingCost).toBeNull();
  });

  it("caps text fields rather than rejecting them", () => {
    const decoded = decodeShippingFacts({
      ...full,
      processingTime: "x".repeat(SHIPPING_FACTS_TEXT_MAX + 50),
    });
    expect(decoded?.processingTime).toHaveLength(SHIPPING_FACTS_TEXT_MAX);
  });

  it("rejects an unknown customs payer instead of guessing one", () => {
    // Guessing "customer" here would have the agent tell a buyer they owe
    // duties the merchant actually absorbs.
    expect(decodeShippingFacts({ ...full, customsDuties: "someone" })).toEqual({
      ...full,
      customsDuties: null,
    });
  });

  it("accepts each customs payer", () => {
    for (const payer of ["customer", "merchant", "not_applicable"] as const) {
      expect(decodeShippingFacts({ ...full, customsDuties: payer })).toEqual({
        ...full,
        customsDuties: payer,
      });
    }
  });

  it("rejects a delay threshold that isn't a sane whole number of days", () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, "14", null]) {
      expect(decodeShippingFacts({ ...full, delayedAfterDays: bad })).toBeNull();
    }
  });

  it("clamps an absurd delay threshold to the cap", () => {
    expect(
      decodeShippingFacts({ ...full, delayedAfterDays: 100_000 })
        ?.delayedAfterDays,
    ).toBe(SHIPPING_FACTS_MAX_DELAY_DAYS);
  });

  it("keeps lostPackageInvestigationDays optional and degrades a bad value to null", () => {
    // A separate number on the same timeline: when we stop waiting and make the
    // customer whole. New field, so an existing profile without it still
    // decodes — it degrades individually rather than nulling the whole block.
    const { lostPackageInvestigationDays: _omit, ...without } = full;
    expect(decodeShippingFacts(without)?.lostPackageInvestigationDays).toBeNull();
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, "30"]) {
      expect(
        decodeShippingFacts({ ...full, lostPackageInvestigationDays: bad })
          ?.lostPackageInvestigationDays,
      ).toBeNull();
    }
  });

  it("clamps an absurd lost-package investigation threshold to the cap", () => {
    expect(
      decodeShippingFacts({ ...full, lostPackageInvestigationDays: 100_000 })
        ?.lostPackageInvestigationDays,
    ).toBe(SHIPPING_FACTS_MAX_DELAY_DAYS);
  });
});
