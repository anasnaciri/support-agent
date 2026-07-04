import { describe, expect, it } from "vitest";

import type { ShopifyFulfillment } from "@support-agent/agent-core";

import {
  fulfillmentDay,
  latestFulfillment,
} from "../app/tickets/[id]/order-panel-data";

// The dashboard reads orders through apps/api over JSON (Path B). JSON has no
// Date type, so a ShopifyFulfillment's `updatedAt` / `estimatedDeliveryAt` /
// `deliveredAt` arrive as ISO *strings* at runtime even though the type says
// `Date`. These fixtures reproduce that — the regression is that the old code
// called `.getTime()` / `.toISOString()` directly on those strings and threw
// `TypeError: ... is not a function`, crashing the whole ticket page on open.
const fulfillment = (
  over: Partial<Record<keyof ShopifyFulfillment, unknown>>,
): ShopifyFulfillment =>
  ({
    id: "f1",
    status: "in_progress",
    trackingCompany: "DHL",
    trackingNumbers: ["JD123"],
    trackingUrls: [],
    estimatedDeliveryAt: null,
    deliveredAt: null,
    createdAt: "2026-06-10T08:00:00.000Z",
    updatedAt: "2026-06-10T08:00:00.000Z",
    ...over,
  }) as unknown as ShopifyFulfillment;

describe("latestFulfillment", () => {
  it("returns null when there are no fulfillments", () => {
    expect(latestFulfillment([])).toBeNull();
  });

  it("picks the most recently updated when dates are ISO strings (JSON wire)", () => {
    const older = fulfillment({ id: "old", updatedAt: "2026-06-10T08:00:00.000Z" });
    const newer = fulfillment({ id: "new", updatedAt: "2026-06-14T09:30:00.000Z" });
    // Must not throw on string `updatedAt`, and must order correctly.
    expect(latestFulfillment([older, newer])?.id).toBe("new");
    expect(latestFulfillment([newer, older])?.id).toBe("new");
  });

  it("also accepts real Date objects", () => {
    const a = fulfillment({ id: "a", updatedAt: new Date("2026-06-10T08:00:00.000Z") });
    const b = fulfillment({ id: "b", updatedAt: new Date("2026-06-14T09:30:00.000Z") });
    expect(latestFulfillment([a, b])?.id).toBe("b");
  });
});

describe("fulfillmentDay", () => {
  it("returns null for an absent date", () => {
    expect(fulfillmentDay(null)).toBeNull();
  });

  it("formats an ISO string (JSON wire) to yyyy-mm-dd without throwing", () => {
    expect(fulfillmentDay("2026-06-15T23:10:00.000Z")).toBe("2026-06-15");
  });

  it("formats a real Date to yyyy-mm-dd", () => {
    expect(fulfillmentDay(new Date("2026-06-15T23:10:00.000Z"))).toBe("2026-06-15");
  });
});
