import type { ShopifyFulfillment } from "@support-agent/agent-core";

import { asDate } from "./format";

// Pure helpers for OrderPanel. Extracted so they can be unit-tested with the
// shapes the data ACTUALLY has at runtime: the dashboard reads orders through
// apps/api over JSON (Path B), and JSON has no Date type — so every
// `ShopifyFulfillment` date field (`updatedAt`, `estimatedDeliveryAt`,
// `deliveredAt`) arrives as an ISO *string*, even though the domain type says
// `Date`. Calling `.getTime()` / `.toISOString()` on those strings throws and
// crashes the ticket page; these helpers coerce first.

/** The most recently updated fulfillment, or null when there are none. */
export const latestFulfillment = (
  fulfillments: ReadonlyArray<ShopifyFulfillment>,
): ShopifyFulfillment | null => {
  if (fulfillments.length === 0) return null;
  return [...fulfillments].sort(
    (a, b) => asDate(b.updatedAt).getTime() - asDate(a.updatedAt).getTime(),
  )[0]!;
};

/** `yyyy-mm-dd` for a fulfillment date, or null when absent. Accepts the ISO
 *  string the JSON wire delivers as well as a real Date. */
export const fulfillmentDay = (
  date: Date | string | null,
): string | null => (date === null ? null : asDate(date).toISOString().slice(0, 10));

/** Whether the order is already cancelled. The Order card uses this to hide
 *  "Cancel order" — the server rejects a second cancel (`already_cancelled`),
 *  so offering the button is a dead end. `cancelledAt` arrives as an ISO
 *  string over the JSON wire, a real Date in domain code. */
export const orderIsCancelled = (order: {
  cancelledAt: Date | string | null;
}): boolean => order.cancelledAt !== null;
