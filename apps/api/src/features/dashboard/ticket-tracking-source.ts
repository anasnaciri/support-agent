// Which tracking number the ticket's Tracking card should follow.
//
// The Shopify fulfillment is the CANONICAL record of an order's tracking
// number — it's what `order.update_tracking`, the fulfillment partner portal's pencil
// edit, and a merchant editing in the Shopify admin all write to, and it's
// re-read live on every request. The ticket's `liveTrackingStatus` stamp is a
// point-in-time snapshot of the agent's last `tracking.lookup`; it goes stale
// the moment the fulfillment's number changes (prod ticket 03649e6f: a reship
// replaced the number, the endpoint kept following the stamp, and the card
// showed the superseded number and its old exception scan forever). So the
// fulfillment wins and the stamp is only the fallback for tickets whose order
// can't be resolved (or has no fulfillment tracking yet).

/** The projection of a Shopify fulfillment the picking logic needs. */
export interface TrackingSourceFulfillment {
  readonly id: string;
  readonly trackingNumbers: ReadonlyArray<string>;
  readonly trackingCompany: string | null;
}

export interface TrackingSource {
  readonly trackingNumber: string;
  readonly carrier: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const stampOf = (
  context: Record<string, unknown>,
): { trackingNumber: string | null; carrier: string | null } => {
  const raw = context["liveTrackingStatus"];
  const r =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return {
    trackingNumber: str(r?.["trackingNumber"]),
    carrier: str(r?.["carrier"]),
  };
};

/**
 * Pick the number (+ carrier hint for the 17track lookup) the Tracking card
 * follows. A ticket-bound fulfillment wins; for legacy tickets, a fulfillment
 * carrying the stamped number wins; only then do we use the first tracked
 * fulfillment. The stamp itself is a fallback only when the order could not be
 * resolved. When the stamp describes the selected number, its provider carrier
 * code wins over re-deriving one from the fulfillment's company name.
 */
export const pickTrackingSource = (
  context: Record<string, unknown>,
  fulfillments: ReadonlyArray<TrackingSourceFulfillment> | null,
): TrackingSource | null => {
  const stamp = stampOf(context);
  const boundFulfillmentId = str(context["trackingFulfillmentId"]);
  if (fulfillments !== null && boundFulfillmentId) {
    const bound = fulfillments.find((ff) => ff.id === boundFulfillmentId);
    if (!bound) return null;
    const trackingNumber = bound.trackingNumbers.find((n) => n.length > 0);
    if (!trackingNumber) return null;
    return {
      trackingNumber,
      carrier:
        stamp.trackingNumber === trackingNumber && stamp.carrier
          ? stamp.carrier
          : bound.trackingCompany,
    };
  }
  const stampMatched = stamp.trackingNumber
    ? fulfillments?.find((ff) =>
        ff.trackingNumbers.includes(stamp.trackingNumber as string),
      )
    : null;
  const f =
    stampMatched ??
    fulfillments?.find((ff) => ff.trackingNumbers.some((n) => n.length > 0)) ??
    null;
  const fulfillmentNumber = f?.trackingNumbers.find((n) => n.length > 0) ?? null;
  if (fulfillmentNumber) {
    return {
      trackingNumber: fulfillmentNumber,
      carrier:
        stamp.trackingNumber === fulfillmentNumber && stamp.carrier
          ? stamp.carrier
          : (f?.trackingCompany ?? null),
    };
  }
  if (fulfillments === null && stamp.trackingNumber) {
    return { trackingNumber: stamp.trackingNumber, carrier: stamp.carrier };
  }
  return null;
};
