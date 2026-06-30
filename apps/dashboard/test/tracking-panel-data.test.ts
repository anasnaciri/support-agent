import { describe, expect, it } from "vitest";

import {
  daysBetween,
  parseLiveTracking,
  publicTrackingUrl,
  trackingStatusVariant,
  trackingUrlFor,
} from "../app/cases/[id]/tracking-panel-data";

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
    });
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
      reason: "unsupported_carrier",
    });
    expect(parsed?.kind).toBe("no_provider");
    expect(parsed?.reason).toBe("unsupported_carrier");
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
