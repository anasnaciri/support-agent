import { Effect, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({
  // Same id shapes `order.cancel` accepts: a Shopify GID. By the time a new
  // tracking number arrives (a supplier update), the agent has already fetched
  // the order and has the GID in scope; order names like `#1001` are NOT
  // accepted.
  orderId: Schema.String,
  trackingNumber: Schema.String,
  // The carrier, or null when the supplier didn't name one (the fulfillment's
  // current carrier is then carried over so the write never drops it).
  trackingCompany: Schema.NullOr(Schema.String),
  // The number being REPLACED — the disambiguator when the order carries
  // several fulfillments (same rule the supplier portal's manual edit uses).
  currentTrackingNumber: Schema.optional(Schema.NullOr(Schema.String)),
});

const Output = Schema.Struct({
  orderId: Schema.String,
  fulfillmentId: Schema.String,
  // What Shopify stored, reported back so the agent quotes the saved state.
  trackingNumber: Schema.String,
  trackingCompany: Schema.NullOr(Schema.String),
});

export const shopifyUpdateTracking = defineTool({
  name: "order.update_tracking",
  description:
    "Replace the tracking number on a Shopify order's fulfillment after the supplier or carrier issued a new one, e.g. a reshipment went out under a new number or the parcel was re-labelled. Use it when a supplier update reports a new tracking number, so the order record stays in sync; only pass a tracking number that was explicitly stated, never guess or construct one. The `orderId` must be a Shopify GID (`gid://shopify/Order/...`); order names like `#1001` are NOT accepted, call `shopify.get_order` first. When the order has more than one fulfillment, pass `currentTrackingNumber` (the old number being replaced, read from the order's fulfillments) so the right fulfillment is updated; without it only an order with exactly ONE fulfillment can be updated (`AmbiguousFulfillment` otherwise). `trackingCompany`: the carrier when one was named, else null to keep the fulfillment's current carrier. The store does NOT email the customer about this change; share the new tracking number in your reply instead. Returns what the store saved. Never call it twice for the same number; if the result is unclear, re-check via `shopify.get_order` instead of retrying.",
  displayDescription:
    "The agent updates an order's tracking number when the supplier or carrier reports a new one, for example after a reshipment.",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  // `allow` by default, unlike the other order writes: the tracking number's
  // authority is the supplier's own statement, and the supplier already holds
  // an UNGATED manual edit of the same fulfillment field in their portal
  // (supplier-tracking.ts). Requiring merchant approval to transcribe it would
  // add friction the manual path doesn't have. Tenants flip it to `ask` with
  // the per-agent toggle.
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  // Deliberately NO requiredConnectorScopes: `fulfillmentTrackingInfoUpdate`
  // accepts ANY ONE of two fulfillment-order write scopes
  // (SHOPIFY_FULFILLMENT_TRACKING_SCOPES), and the permission precheck is
  // all-of — declaring both would deny stores that legitimately hold one.
  // A missing scope surfaces as Shopify's own refusal (FulfillmentUpdateFailed).
  idempotencyKey: (input) => `track:${input.orderId}:${input.trackingNumber}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const fail = (issue: string) =>
        Effect.fail(
          new ToolOutputInvalid({
            tool: "order.update_tracking",
            issues: [issue],
          }),
        );

      const trackingNumber = input.trackingNumber.trim();
      if (trackingNumber.length === 0) {
        return yield* fail("TrackingNumberRequired");
      }

      const shopify = yield* ShopifyService;
      const order = yield* shopify
        .getOrder(ctx.tenantId, OrderId(input.orderId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "order.update_tracking",
                issues: [e._tag],
              }),
          ),
        );

      // Which fulfillment? Same rule as the supplier portal's manual edit
      // (supplier-tracking.ts): the fulfillment currently carrying the number
      // being replaced is the one being talked about; with no match, only an
      // order with exactly ONE fulfillment is safe — refuse rather than guess.
      if (order.fulfillments.length === 0) {
        return yield* fail("NoFulfillment");
      }
      const current = input.currentTrackingNumber ?? null;
      const matched = current
        ? order.fulfillments.find((f) => f.trackingNumbers.includes(current))
        : undefined;
      const picked =
        matched ??
        (order.fulfillments.length === 1 ? order.fulfillments[0]! : undefined);
      if (!picked) {
        return yield* fail("AmbiguousFulfillment");
      }

      const stored = yield* shopify
        .updateFulfillmentTracking(ctx.tenantId, {
          fulfillmentId: picked.id,
          trackingNumber,
          // No carrier named → carry the fulfillment's current one over, so
          // replacing the number doesn't silently drop the carrier (Shopify
          // derives the tracking URL from it).
          trackingCompany: input.trackingCompany ?? picked.trackingCompany,
          // Customer communication goes through the agent's reply — never a
          // side-channel Shopify shipping-update email.
          notifyCustomer: false,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "order.update_tracking",
                issues: [e._tag],
              }),
          ),
        );

      return {
        orderId: order.id,
        fulfillmentId: stored.id,
        trackingNumber: stored.trackingNumbers[0] ?? trackingNumber,
        trackingCompany: stored.trackingCompany,
      };
    }),
});
