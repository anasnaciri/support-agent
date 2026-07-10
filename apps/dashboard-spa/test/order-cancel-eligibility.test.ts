import { describe, expect, it } from "vitest";

import { orderCancelState } from "@/lib/order-cancel-eligibility";

describe("orderCancelState — when the operator may cancel from the Order card", () => {
  it("allows cancelling an unfulfilled, open order", () => {
    expect(
      orderCancelState({ cancelledAt: null, fulfillmentStatus: "unfulfilled" }),
    ).toEqual({ canCancel: true, reason: null });
  });

  it("allows cancelling an order Shopify has not given a fulfillment status", () => {
    expect(
      orderCancelState({ cancelledAt: null, fulfillmentStatus: null }),
    ).toEqual({ canCancel: true, reason: null });
  });

  it("refuses an order that is already cancelled", () => {
    const state = orderCancelState({
      cancelledAt: new Date("2026-07-01T10:00:00Z"),
      fulfillmentStatus: "unfulfilled",
    });
    expect(state.canCancel).toBe(false);
    expect(state.reason).toBe("This order is already cancelled.");
  });

  it("refuses every shipped-or-shipping order — Shopify rejects those", () => {
    for (const fulfillmentStatus of [
      "fulfilled",
      "partial",
      "in_transit",
      "out_for_delivery",
      "delivered",
      "attempted_delivery",
    ] as const) {
      const state = orderCancelState({ cancelledAt: null, fulfillmentStatus });
      expect(state.canCancel, fulfillmentStatus).toBe(false);
      expect(state.reason, fulfillmentStatus).toBe(
        "This order has already shipped. Refund it instead.",
      );
    }
  });

  it("prefers the already-cancelled reason over the shipped one", () => {
    const state = orderCancelState({
      cancelledAt: new Date("2026-07-01T10:00:00Z"),
      fulfillmentStatus: "fulfilled",
    });
    expect(state.reason).toBe("This order is already cancelled.");
  });

  it("refuses an unknown fulfillment status rather than guessing", () => {
    // Fail closed: a status we don't recognize might mean the parcel is gone.
    const state = orderCancelState({
      cancelledAt: null,
      fulfillmentStatus: "some_new_shopify_status" as never,
    });
    expect(state.canCancel).toBe(false);
  });
});
