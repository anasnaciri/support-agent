import { describe, expect, it } from "vitest";
import { parseShippingFactsInput } from "../settings-handlers.js";

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  processingTime: "1–2 business days",
  deliveryTime: "7–12 days",
  shippingCost: "Free over $50",
  customsDuties: "customer",
  delayedAfterDays: 14,
  ...over,
});

describe("parseShippingFactsInput", () => {
  it("accepts a fully populated form", () => {
    const got = parseShippingFactsInput(body());
    expect(got).toEqual({
      ok: true,
      facts: {
        processingTime: "1–2 business days",
        deliveryTime: "7–12 days",
        shippingCost: "Free over $50",
        customsDuties: "customer",
        delayedAfterDays: 14,
        lostPackageInvestigationDays: null,
      },
    });
  });

  it("accepts the optional fields as absent", () => {
    const got = parseShippingFactsInput({
      processingTime: "1 day",
      deliveryTime: "5 days",
      delayedAfterDays: 9,
    });
    expect(got).toEqual({
      ok: true,
      facts: {
        processingTime: "1 day",
        deliveryTime: "5 days",
        shippingCost: null,
        customsDuties: null,
        delayedAfterDays: 9,
        lostPackageInvestigationDays: null,
      },
    });
  });

  it("accepts the optional lost-package investigation threshold", () => {
    // Merchant's second timeline point: when to stop waiting and make the
    // customer whole. Optional and coerces a numeric string like the required
    // threshold does; a bad value degrades to null rather than failing the save.
    expect(
      parseShippingFactsInput(body({ lostPackageInvestigationDays: 30 })),
    ).toEqual({
      ok: true,
      facts: expect.objectContaining({ lostPackageInvestigationDays: 30 }),
    });
    expect(
      parseShippingFactsInput(body({ lostPackageInvestigationDays: "45" })),
    ).toEqual({
      ok: true,
      facts: expect.objectContaining({ lostPackageInvestigationDays: 45 }),
    });
    expect(
      parseShippingFactsInput(body({ lostPackageInvestigationDays: "soon" })),
    ).toEqual({
      ok: true,
      facts: expect.objectContaining({ lostPackageInvestigationDays: null }),
    });
  });

  it("names the field that failed so the form can point at it", () => {
    expect(parseShippingFactsInput(body({ processingTime: "  " }))).toEqual({
      ok: false,
      error: "invalid_processing_time",
    });
    expect(parseShippingFactsInput(body({ deliveryTime: 42 }))).toEqual({
      ok: false,
      error: "invalid_delivery_time",
    });
    expect(parseShippingFactsInput(body({ delayedAfterDays: 0 }))).toEqual({
      ok: false,
      error: "invalid_delay_days",
    });
    expect(parseShippingFactsInput(body({ delayedAfterDays: 2.5 }))).toEqual({
      ok: false,
      error: "invalid_delay_days",
    });
    expect(parseShippingFactsInput(body({ delayedAfterDays: "soon" }))).toEqual({
      ok: false,
      error: "invalid_delay_days",
    });
  });

  it("coerces a numeric string threshold — a number input round-trips as text", () => {
    const got = parseShippingFactsInput(body({ delayedAfterDays: "21" }));
    expect(got).toEqual({
      ok: true,
      facts: expect.objectContaining({ delayedAfterDays: 21 }),
    });
  });

  it("drops an unrecognised customs payer rather than rejecting the whole form", () => {
    // The three text fields are what the merchant cares about; a stale enum from
    // an old tab shouldn't block the save. It degrades to "unspecified".
    const got = parseShippingFactsInput(body({ customsDuties: "martians" }));
    expect(got).toEqual({
      ok: true,
      facts: expect.objectContaining({ customsDuties: null }),
    });
  });

  it("normalizes through the same decoder the agent runtime reads", () => {
    const got = parseShippingFactsInput(
      body({ processingTime: "  1 day  ", shippingCost: "   ", delayedAfterDays: 100000 }),
    );
    expect(got).toEqual({
      ok: true,
      facts: expect.objectContaining({
        processingTime: "1 day",
        shippingCost: null,
        delayedAfterDays: 365,
      }),
    });
  });
});
