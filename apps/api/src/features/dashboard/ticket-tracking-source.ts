// Which tracking number the ticket's Tracking card should follow.
//
// The Shopify fulfillment is the CANONICAL record of an order's tracking
// number — it's what `order.update_tracking`, the supplier portal's pencil
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
 * follows: the order's first fulfillment carrying a tracking number, else the
 * on-ticket stamp, else null. When the stamp describes the SAME number the
 * fulfillment carries, its carrier wins the hint — it's the 17track carrier
 * code that already produced a successful lookup, sharper than re-deriving
 * from the fulfillment's company name.
 */
export const pickTrackingSource = (
  context: Record<string, unknown>,
  fulfillments: ReadonlyArray<TrackingSourceFulfillment> | null,
): TrackingSource | null => {
  const stamp = stampOf(context);
  const f =
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
  if (stamp.trackingNumber) {
    return { trackingNumber: stamp.trackingNumber, carrier: stamp.carrier };
  }
  return null;
};
