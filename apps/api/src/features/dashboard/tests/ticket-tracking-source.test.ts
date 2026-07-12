import { describe, expect, it } from "vitest";
import { pickTrackingSource } from "../ticket-tracking-source.js";

// Which tracking number the Tracking card's live lookup should follow.
// Regression: prod ticket 03649e6f (2026-07-12) — the endpoint preferred the
// ticket's liveTrackingStatus stamp over the order's fulfillment, so after a
// reship replaced the fulfillment's number the card kept looking up (and
// showing) the superseded one. The order's live fulfillment is the canonical
// source; the stamp is only a fallback for tickets without a resolved order.

const stampContext = (trackingNumber: string, carrier: string | null) => ({
  liveTrackingStatus: { kind: "live", trackingNumber, carrier },
});

const fulfillment = (
  trackingNumbers: ReadonlyArray<string>,
  trackingCompany: string | null = "USPS",
) => ({ trackingNumbers, trackingCompany });

describe("pickTrackingSource", () => {
  it("follows the order's fulfillment number over a stale stamp", () => {
    expect(
      pickTrackingSource(stampContext("OLD123", "191997"), [
        fulfillment(["NEW456"]),
      ]),
    ).toEqual({ trackingNumber: "NEW456", carrier: "USPS" });
  });

  it("keeps the stamp's carrier hint when the stamp describes the same number", () => {
    // The stamp's carrier is the 17track carrier code that already produced a
    // successful lookup — better than re-deriving from the company name.
    expect(
      pickTrackingSource(stampContext("SAME789", "191997"), [
        fulfillment(["SAME789"]),
      ]),
    ).toEqual({ trackingNumber: "SAME789", carrier: "191997" });
  });

  it("uses the first fulfillment that carries a tracking number", () => {
    expect(
      pickTrackingSource({}, [fulfillment([]), fulfillment(["ABC1"], "DHL")]),
    ).toEqual({ trackingNumber: "ABC1", carrier: "DHL" });
  });

  it("falls back to the stamp when the order has no fulfillment tracking", () => {
    expect(pickTrackingSource(stampContext("OLD123", "191997"), [fulfillment([])]))
      .toEqual({ trackingNumber: "OLD123", carrier: "191997" });
  });

  it("falls back to the stamp when the order could not be resolved", () => {
    expect(pickTrackingSource(stampContext("OLD123", null), null)).toEqual({
      trackingNumber: "OLD123",
      carrier: null,
    });
  });

  it("returns null when neither side has a number", () => {
    expect(pickTrackingSource({}, null)).toBeNull();
    expect(pickTrackingSource({}, [fulfillment([])])).toBeNull();
    expect(pickTrackingSource({ liveTrackingStatus: { kind: "live" } }, null)).toBeNull();
  });

  it("tolerates a malformed stamp", () => {
    expect(
      pickTrackingSource({ liveTrackingStatus: "garbage" }, [
        fulfillment(["NEW456"], null),
      ]),
    ).toEqual({ trackingNumber: "NEW456", carrier: null });
  });
});
