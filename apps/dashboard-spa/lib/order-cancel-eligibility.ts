import type { ShopifyOrder } from "@support-agent/agent-core";

/**
 * Whether the Order card may offer "Cancel order", and the merchant-facing
 * reason when it may not.
 *
 * Shopify's `orderCancel` rejects an order that already carries a fulfillment
 * or a cancellation, so this mirrors the server guard client-side: the button
 * explains itself rather than posting a request the store will refuse. The
 * server is still the authority — this only decides what the button looks
 * like.
 *
 * Fails CLOSED on an unrecognized fulfillment status: a status we don't know
 * may mean the parcel is already moving, and offering to cancel it would
 * promise the customer something the store won't honor.
 */
const CANCELLABLE_FULFILLMENT_STATUSES: ReadonlySet<string> = new Set([
  "unfulfilled",
]);

export interface OrderCancelState {
  readonly canCancel: boolean;
  /** Merchant-facing copy for the disabled button's tooltip; null when enabled. */
  readonly reason: string | null;
}

export const orderCancelState = (
  order: Pick<ShopifyOrder, "cancelledAt" | "fulfillmentStatus">,
): OrderCancelState => {
  if (order.cancelledAt !== null) {
    return { canCancel: false, reason: "This order is already cancelled." };
  }
  const status = order.fulfillmentStatus;
  if (status !== null && !CANCELLABLE_FULFILLMENT_STATUSES.has(status)) {
    return {
      canCancel: false,
      reason: "This order has already shipped. Refund it instead.",
    };
  }
  return { canCancel: true, reason: null };
};
