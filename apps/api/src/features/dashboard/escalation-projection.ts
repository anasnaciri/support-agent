import { Effect } from "effect";
import {
  OrderId,
  type ShopifyOrder,
  type TenantId,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";
import { isNonEmptyString, looksLikeGid } from "./shopify-panels.js";

// The order projection a MANUAL fulfillment partner escalation carries — the same
// customer-PII-free slice the agent's fulfillment_operator.escalate tool sends (order ref,
// ship city/country, tracking number), derived server-side from the ticket's
// bound order so the merchant doesn't have to retype it.

export interface FulfillmentOperatorOrderProjection {
  readonly orderRef: string | null;
  readonly shipCity: string | null;
  readonly shipCountry: string | null;
  readonly trackingNumber: string | null;
}

const NULL_PROJECTION: FulfillmentOperatorOrderProjection = {
  orderRef: null,
  shipCity: null,
  shipCountry: null,
  trackingNumber: null,
};

/**
 * Project the fulfillment-partner-visible order facts. Deliberately excludes the
 * customer's name/street/email — city + country are enough for the warehouse
 * to identify the shipment. Tracking comes from the NEWEST fulfillment that
 * actually carries a number (a reshipped order's latest label, not the first).
 */
export const fulfillmentOperatorOrderProjection = (
  order: ShopifyOrder | null,
): FulfillmentOperatorOrderProjection => {
  if (!order) return NULL_PROJECTION;
  const tracked = order.fulfillments
    .filter((f) => f.trackingNumbers.length > 0)
    .reduce<ShopifyOrder["fulfillments"][number] | null>(
      (newest, f) =>
        newest === null || f.createdAt.getTime() > newest.createdAt.getTime()
          ? f
          : newest,
      null,
    );
  return {
    orderRef: order.name,
    shipCity: order.shippingAddress?.city ?? null,
    shipCountry: order.shippingAddress?.country ?? null,
    trackingNumber: tracked?.trackingNumbers[0] ?? null,
  };
};

/**
 * The ticket's bound order for FULFILLMENT_OPERATOR-facing data: canonical
 * `identifiedOrderId` GID or nothing. Unlike the panels'
 * `resolveOrderForContext`, this never falls back to the customer's
 * `quotedOrderRef` or fuzzy name/confirmation lookups — an untrusted hint
 * resolving to the wrong order could tell a warehouse to reship someone
 * else's shipment. Best-effort: any lookup failure (no Shopify connection,
 * order gone) resolves to null and the escalation proceeds without the
 * projection.
 */
export const resolveCanonicalOrder = (
  tenantId: TenantId,
  context: Readonly<Record<string, unknown>>,
): Effect.Effect<ShopifyOrder | null, never, ShopifyService> =>
  Effect.gen(function* () {
    const canonical = context["identifiedOrderId"];
    if (!isNonEmptyString(canonical) || !looksLikeGid(canonical)) return null;
    const shopify = yield* ShopifyService;
    return yield* shopify
      .getOrder(tenantId, OrderId(canonical))
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
  });
