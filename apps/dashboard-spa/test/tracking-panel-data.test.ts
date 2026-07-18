import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TrackingPanel } from "../features/tickets/TrackingPanel";
import {
  daysBetween,
  dropSupersededStamp,
  parseLiveTracking,
  publicTrackingUrl,
  trackingStatusVariant,
  trackingUrlFor,
} from "../lib/tracking-panel-data";

describe("parseLiveTracking", () => {
  it("returns null for absent / non-tracking / malformed values", () => {
    expect(parseLiveTracking(undefined)).toBeNull();
    expect(parseLiveTracking(null)).toBeNull();
    expect(parseLiveTracking("nope")).toBeNull();
    expect(parseLiveTracking([])).toBeNull();
    expect(parseLiveTracking({ kind: "other" })).toBeNull();
    // valid kind but nothing useful → no card
    expect(parseLiveTracking({ kind: "live" })).toBeNull();
  });

  it("parses a full live stamp", () => {
    const parsed = parseLiveTracking({
      kind: "live",
      status: "in_transit",
      carrier: "lulu",
      trackingNumber: "LULU1000509755",
      lastScan: {
        occurredAt: "2026-05-27T08:32:00.000Z",
        location: "China",
        description: "Delayed for postage assessment",
      },
      estimatedDeliveryAt: "2026-06-10T00:00:00.000Z",
      trackingUrl: "https://example.test/track",
    });
    expect(parsed).toEqual({
      kind: "live",
      status: "in_transit",
      carrier: "lulu",
      trackingNumber: "LULU1000509755",
      lastScan: {
        occurredAt: "2026-05-27T08:32:00.000Z",
        location: "China",
        description: "Delayed for postage assessment",
      },
      estimatedDeliveryAt: "2026-06-10T00:00:00.000Z",
      trackingUrl: "https://example.test/track",
      reason: null,
      originCountry: null,
      destinationCountry: null,
      transitDays: null,
      checkpoints: [],
    });
  });

  it("parses the rich live endpoint shape (origin/destination/transit/checkpoints)", () => {
    const parsed = parseLiveTracking({
      kind: "live",
      status: "in_transit",
      carrier: "lulu",
      trackingNumber: "LULU1000509755",
      originCountry: "China",
      destinationCountry: "United States",
      transitDays: 49,
      checkpoints: [
        {
          occurredAt: "2026-05-27T08:32:00.000Z",
          location: "China",
          description: "Item in transit to destination",
        },
        { occurredAt: "bad-date", location: null, description: "dropped" },
        {
          occurredAt: "2026-05-10T03:00:00.000Z",
          location: "Shenzhen, China",
          description: "Delayed for postage assessment",
        },
      ],
    });
    expect(parsed?.originCountry).toBe("China");
    expect(parsed?.destinationCountry).toBe("United States");
    expect(parsed?.transitDays).toBe(49);
    // the malformed checkpoint (no valid occurredAt) is dropped
    expect(parsed?.checkpoints).toHaveLength(2);
    expect(parsed?.checkpoints[0]?.description).toBe(
      "Item in transit to destination",
    );
  });

  it("drops an unknown status and a malformed lastScan but keeps the rest", () => {
    const parsed = parseLiveTracking({
      kind: "live",
      status: "teleporting",
      carrier: "UPS",
      trackingNumber: "1Z",
      lastScan: { location: "no time" },
    });
    expect(parsed?.status).toBeNull();
    expect(parsed?.lastScan).toBeNull();
    expect(parsed?.carrier).toBe("UPS");
    expect(parsed?.trackingNumber).toBe("1Z");
  });

  it("keeps the no_provider arm with its reason", () => {
    const parsed = parseLiveTracking({
      kind: "no_provider",
      carrier: "lulu",
      trackingNumber: "LULU1",
      reason: "sync_pending",
    });
    expect(parsed?.kind).toBe("no_provider");
    expect(parsed?.reason).toBe("sync_pending");
  });
});

// The on-ticket stamp is a snapshot of the agent's LAST tracking.lookup. When
// the order's fulfillment now carries a different number (a reship, a
// re-label, a Shopify-admin edit), the snapshot describes a superseded
// shipment and must not be rendered as this order's tracking (prod ticket
// 03649e6f: the card kept a reshipped parcel's old number + exception scan).
describe("dropSupersededStamp", () => {
  const stamp = parseLiveTracking({
    kind: "live",
    status: "exception",
    carrier: "191997",
    trackingNumber: "OLD123",
  });

  it("drops the stamp when the order tracks under a different number", () => {
    expect(dropSupersededStamp(stamp, ["NEW456"])).toBeNull();
  });

  it("keeps the stamp when the order still carries its number", () => {
    expect(dropSupersededStamp(stamp, ["NEW456", "OLD123"])).toBe(stamp);
  });

  it("drops the stamp when the resolved order has no tracking numbers", () => {
    expect(dropSupersededStamp(stamp, [], true)).toBeNull();
  });

  it("keeps a disputed stamp visible when the order has no tracking numbers", () => {
    expect(
      dropSupersededStamp(stamp, [], true, [
        "tracking_destination_mismatch",
      ]),
    ).toBe(stamp);
  });

  it("still drops a disputed stamp when the order has a different number", () => {
    expect(
      dropSupersededStamp(stamp, ["NEW456"], true, [
        "tracking_destination_mismatch",
      ]),
    ).toBeNull();
  });

  it("keeps the stamp when the order could not be resolved", () => {
    expect(dropSupersededStamp(stamp, [], false)).toBe(stamp);
  });

  it("keeps a stamp that names no number (cannot be compared)", () => {
    const numberless = parseLiveTracking({
      kind: "live",
      status: "in_transit",
      carrier: "lulu",
    });
    expect(dropSupersededStamp(numberless, ["NEW456"])).toBe(numberless);
  });

  it("passes null through", () => {
    expect(dropSupersededStamp(null, ["NEW456"])).toBeNull();
  });
});

describe("TrackingPanel", () => {
  it("warns when the displayed tracking may belong to another order", () => {
    const tracking = parseLiveTracking({
      kind: "live",
      status: "delivered",
      carrier: "191047",
      trackingNumber: "1ST04211945613",
      destinationCountry: "DE",
    });
    expect(tracking).not.toBeNull();

    const html = renderToStaticMarkup(
      createElement(TrackingPanel, {
        tracking: tracking!,
        destinationCountry: "United States",
        orderPlacedAt: null,
        destinationMismatch: true,
      }),
    );

    expect(html).toContain("Tracking may belong to a different order");
  });
});

describe("trackingUrlFor / publicTrackingUrl", () => {
  it("prefers the provider url, else builds the public 17track url", () => {
    expect(
      trackingUrlFor({
        kind: "live",
        trackingNumber: "X1",
        carrier: null,
        status: null,
        lastScan: null,
        estimatedDeliveryAt: null,
        trackingUrl: "https://carrier.test/x",
        reason: null,
        originCountry: null,
        destinationCountry: null,
        transitDays: null,
        checkpoints: [],
      }),
    ).toBe("https://carrier.test/x");
    expect(publicTrackingUrl("LULU 1/2")).toBe(
      "https://t.17track.net/en#nums=LULU%201%2F2",
    );
  });
});

describe("trackingStatusVariant", () => {
  it("maps each status to a badge tone", () => {
    expect(trackingStatusVariant("delivered")).toBe("success");
    expect(trackingStatusVariant("in_transit")).toBe("default");
    expect(trackingStatusVariant("exception")).toBe("destructive");
    expect(trackingStatusVariant("pending")).toBe("muted");
    expect(trackingStatusVariant("unknown")).toBe("muted");
  });
});

describe("daysBetween", () => {
  const now = Date.parse("2026-05-30T00:00:00.000Z");
  it("counts whole days from an ISO string or Date", () => {
    expect(daysBetween("2026-05-27T00:00:00.000Z", now)).toBe(3);
    expect(daysBetween(new Date("2026-05-20T00:00:00.000Z"), now)).toBe(10);
  });
  it("returns null for missing, unparseable, or future dates", () => {
    expect(daysBetween(null, now)).toBeNull();
    expect(daysBetween("not-a-date", now)).toBeNull();
    expect(daysBetween("2026-06-10T00:00:00.000Z", now)).toBeNull();
  });
});
