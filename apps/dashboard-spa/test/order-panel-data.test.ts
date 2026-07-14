import { describe, expect, it } from "vitest";

import type { ShopifyFulfillment } from "@support-agent/agent-core";

import {
  addressEditDisabledReason,
  cancelOrderDisabledReason,
  fulfillmentDay,
  latestFulfillment,
  orderIsCancelled,
} from "../lib/order-panel-data";

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

// The Order card must not offer "Cancel order" for an order that is already
// cancelled — the server rejects it (`already_cancelled`), so showing the
// button is a dead end. `cancelledAt` rides the same JSON wire as the
// fulfillment dates, so it arrives as an ISO string, not a Date.
describe("orderIsCancelled", () => {
  it("false when cancelledAt is null", () => {
    expect(orderIsCancelled({ cancelledAt: null })).toBe(false);
  });

  it("true for an ISO string cancelledAt (JSON wire)", () => {
    expect(orderIsCancelled({ cancelledAt: "2026-07-08T14:01:35.000Z" })).toBe(
      true,
    );
  });

  it("true for a real Date cancelledAt", () => {
    expect(
      orderIsCancelled({ cancelledAt: new Date("2026-07-08T14:01:35.000Z") }),
    ).toBe(true);
  });
});

// The Order card's action buttons stay VISIBLE but disable with a reason the
// operator can read, instead of silently vanishing.
describe("cancelOrderDisabledReason", () => {
  it("null for a live order", () => {
    expect(cancelOrderDisabledReason({ cancelledAt: null })).toBeNull();
  });

  it("explains when the order is already cancelled (ISO-string wire)", () => {
    expect(
      cancelOrderDisabledReason({ cancelledAt: "2026-07-08T14:01:35.000Z" }),
    ).toMatch(/already been cancelled/);
  });
});

describe("addressEditDisabledReason", () => {
  const unshipped = { fulfillments: [] };
  const shipped = { fulfillments: [fulfillment({})] };

  it("null for an unshipped order regardless of the setting", () => {
    expect(addressEditDisabledReason(unshipped, false)).toBeNull();
    expect(addressEditDisabledReason(unshipped, true)).toBeNull();
  });

  it("explains when the order shipped and the store disallows post-fulfillment edits", () => {
    expect(addressEditDisabledReason(shipped, false)).toMatch(
      /already shipped/,
    );
  });

  it("null for a shipped order when the store allows post-fulfillment edits", () => {
    expect(addressEditDisabledReason(shipped, true)).toBeNull();
  });
});
