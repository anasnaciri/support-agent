import { describe, expect, it } from "vitest";
import {
  SHIPPING_PROFILE_MAX_DELAY_DAYS,
  SHIPPING_PROFILE_TEXT_MAX,
  decodeShippingProfile,
  type ShippingProfile,
} from "../src/shipping-profile.js";

const full: ShippingProfile = {
  processingTime: "1–2 business days",
  deliveryTime: "7–12 days",
  shippingCost: "Free over $50, otherwise $4.95",
  customsDuties: "customer",
  delayedAfterDays: 14,
};

describe("decodeShippingProfile", () => {
  it("round-trips a fully populated profile", () => {
    expect(decodeShippingProfile({ ...full })).toEqual(full);
  });

  it("treats an unconfigured profile as null", () => {
    // A tenant that never opened the form has no `shippingProfile` key at all.
    expect(decodeShippingProfile(undefined)).toBeNull();
    expect(decodeShippingProfile(null)).toBeNull();
    expect(decodeShippingProfile("not an object")).toBeNull();
    expect(decodeShippingProfile([])).toBeNull();
  });

  it("requires the three starred fields — a partial block decodes to null", () => {
    // Defaults-on-read must never invent a delivery window or a delay
    // threshold: a half-written block is no profile at all, which sends the
    // agent back to knowledge.search rather than to a made-up number.
    expect(decodeShippingProfile({ ...full, processingTime: "" })).toBeNull();
    expect(decodeShippingProfile({ ...full, deliveryTime: "   " })).toBeNull();
    expect(decodeShippingProfile({ ...full, delayedAfterDays: null })).toBeNull();
    const { deliveryTime: _omit, ...missing } = full;
    expect(decodeShippingProfile(missing)).toBeNull();
  });

  it("keeps the optional fields optional", () => {
    expect(
      decodeShippingProfile({
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
    });
  });

  it("trims text and drops a blank optional to null", () => {
    const decoded = decodeShippingProfile({
      ...full,
      processingTime: "  1–2 business days  ",
      shippingCost: "   ",
    });
    expect(decoded?.processingTime).toBe("1–2 business days");
    expect(decoded?.shippingCost).toBeNull();
  });

  it("caps text fields rather than rejecting them", () => {
    const decoded = decodeShippingProfile({
      ...full,
      processingTime: "x".repeat(SHIPPING_PROFILE_TEXT_MAX + 50),
    });
    expect(decoded?.processingTime).toHaveLength(SHIPPING_PROFILE_TEXT_MAX);
  });

  it("rejects an unknown customs payer instead of guessing one", () => {
    // Guessing "customer" here would have the agent tell a buyer they owe
    // duties the merchant actually absorbs.
    expect(decodeShippingProfile({ ...full, customsDuties: "someone" })).toEqual({
      ...full,
      customsDuties: null,
    });
  });

  it("accepts each customs payer", () => {
    for (const payer of ["customer", "merchant", "not_applicable"] as const) {
      expect(decodeShippingProfile({ ...full, customsDuties: payer })).toEqual({
        ...full,
        customsDuties: payer,
      });
    }
  });

  it("rejects a delay threshold that isn't a sane whole number of days", () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, "14", null]) {
      expect(decodeShippingProfile({ ...full, delayedAfterDays: bad })).toBeNull();
    }
  });

  it("clamps an absurd delay threshold to the cap", () => {
    expect(
      decodeShippingProfile({ ...full, delayedAfterDays: 100_000 })
        ?.delayedAfterDays,
    ).toBe(SHIPPING_PROFILE_MAX_DELAY_DAYS);
  });
});
