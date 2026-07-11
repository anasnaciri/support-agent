import { describe, expect, it } from "vitest";
import { parseReturnsFactsInput } from "../settings-handlers.js";

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  returnWindowDays: 30,
  returnShippingPayer: "customer",
  refundMethod: "original",
  refundProcessingTime: "5–7 business days",
  ...over,
});

describe("parseReturnsFactsInput", () => {
  it("accepts a fully populated form", () => {
    expect(parseReturnsFactsInput(body())).toEqual({
      ok: true,
      facts: {
        returnWindowDays: 30,
        returnShippingPayer: "customer",
        refundMethod: "original",
        refundProcessingTime: "5–7 business days",
      },
    });
  });

  it("accepts the optional fields as absent", () => {
    expect(parseReturnsFactsInput({ returnWindowDays: 14 })).toEqual({
      ok: true,
      facts: {
        returnWindowDays: 14,
        returnShippingPayer: null,
        refundMethod: null,
        refundProcessingTime: null,
      },
    });
  });

  it("names the return window when it fails so the form can point at it", () => {
    expect(parseReturnsFactsInput({ returnShippingPayer: "customer" })).toEqual({
      ok: false,
      error: "invalid_return_window",
    });
    expect(parseReturnsFactsInput(body({ returnWindowDays: 0 }))).toEqual({
      ok: false,
      error: "invalid_return_window",
    });
    expect(parseReturnsFactsInput(body({ returnWindowDays: 2.5 }))).toEqual({
      ok: false,
      error: "invalid_return_window",
    });
    expect(parseReturnsFactsInput(body({ returnWindowDays: "soon" }))).toEqual({
      ok: false,
      error: "invalid_return_window",
    });
  });

  it("coerces a numeric string window — a number input round-trips as text", () => {
    expect(parseReturnsFactsInput(body({ returnWindowDays: "21" }))).toEqual({
      ok: true,
      facts: expect.objectContaining({ returnWindowDays: 21 }),
    });
  });

  it("drops an unrecognised payer / method rather than rejecting the whole form", () => {
    // A stale enum from an old tab shouldn't block the save — it degrades to
    // "unspecified", never to a wrong-but-plausible default.
    expect(
      parseReturnsFactsInput(body({ returnShippingPayer: "martians" })),
    ).toEqual({
      ok: true,
      facts: expect.objectContaining({ returnShippingPayer: null }),
    });
    expect(parseReturnsFactsInput(body({ refundMethod: "cash" }))).toEqual({
      ok: true,
      facts: expect.objectContaining({ refundMethod: null }),
    });
  });

  it("normalizes through the same decoder the agent runtime reads", () => {
    expect(
      parseReturnsFactsInput(
        body({ refundProcessingTime: "  a week  ", returnWindowDays: 100000 }),
      ),
    ).toEqual({
      ok: true,
      facts: expect.objectContaining({
        refundProcessingTime: "a week",
        returnWindowDays: 365,
      }),
    });
  });
});
