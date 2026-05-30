import { Effect, Schema } from "effect";
import {
  defineTool,
  OrderId,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Input = Schema.Struct({
  orderId: Schema.String,
});

const Money = Schema.Struct({
  amount: Schema.String,
  currencyCode: Schema.String,
});

const TrackingEntry = Schema.Struct({
  company: Schema.NullOr(Schema.String),
  numbers: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
});

const Fulfillment = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  tracking: TrackingEntry,
  estimatedDeliveryAt: Schema.NullOr(Schema.String),
  deliveredAt: Schema.NullOr(Schema.String),
});

const Output = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  fulfillmentStatus: Schema.NullOr(Schema.String),
  financialStatus: Schema.NullOr(Schema.String),
  totalPrice: Money,
  shippingAddress: Schema.NullOr(
    Schema.Struct({
      name: Schema.NullOr(Schema.String),
      address1: Schema.NullOr(Schema.String),
      city: Schema.NullOr(Schema.String),
      province: Schema.NullOr(Schema.String),
      country: Schema.NullOr(Schema.String),
      zip: Schema.NullOr(Schema.String),
    }),
  ),
  lineItems: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      quantity: Schema.Number,
      sku: Schema.NullOr(Schema.String),
      productId: Schema.NullOr(Schema.String),
    }),
  ),
  fulfillments: Schema.Array(Fulfillment),
});

export const shopifyGetOrder = defineTool({
  name: "shopify.get_order",
  description:
    "Look up a Shopify order. Accepts the merchant-facing order name (`#1001`, with or without the leading `#`), the numeric Shopify internal id, or a `gid://shopify/Order/...` GID. Returns the order with line items, fulfillment status, financial status, and tracking info. Use this to answer 'where is my order?' questions — customers typically reference orders by name (`#1001`), not by internal id.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["read_orders"],
  },
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;

      // Branch on input shape:
      //   - `gid://shopify/Order/<n>` → direct id lookup (the rare power-
      //     user case where the caller already has a GID).
      //   - `#1001` or `1001` (any non-GID string) → name search through
      //     `findOrderByName`. Customers reference orders by their name,
      //     not their internal numeric id, so this is the common path.
      // The name-search returns `null` (not a typed error) when no match
      // is found — map that to `OrderNotFound` at the tool boundary so the
      // LLM sees the same failure shape as a by-id miss.
      const raw = input.orderId;
      const order = raw.startsWith("gid://")
        ? yield* shopify
            .getOrder(ctx.tenantId, OrderId(raw))
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolOutputInvalid({
                    tool: "shopify.get_order",
                    issues: [e._tag],
                  }),
              ),
            )
        : yield* shopify
            .findOrderByName(ctx.tenantId, raw)
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolOutputInvalid({
                    tool: "shopify.get_order",
                    issues: [e._tag],
                  }),
              ),
              Effect.flatMap((o) =>
                o
                  ? Effect.succeed(o)
                  : Effect.fail(
                      new ToolOutputInvalid({
                        tool: "shopify.get_order",
                        issues: ["OrderNotFound"],
                      }),
                    ),
              ),
            );
      return {
        id: order.id,
        name: order.name,
        email: order.email,
        fulfillmentStatus: order.fulfillmentStatus,
        financialStatus: order.financialStatus,
        totalPrice: order.totalPrice,
        shippingAddress: order.shippingAddress
          ? {
              name: order.shippingAddress.name,
              address1: order.shippingAddress.address1,
              city: order.shippingAddress.city,
              province: order.shippingAddress.province,
              country: order.shippingAddress.country,
              zip: order.shippingAddress.zip,
            }
          : null,
        lineItems: order.lineItems.map((li) => ({
          id: li.id,
          title: li.title,
          quantity: li.quantity,
          sku: li.sku,
          productId: li.productId,
        })),
        fulfillments: order.fulfillments.map((f) => ({
          id: f.id,
          status: f.status,
          tracking: {
            company: f.trackingCompany,
            numbers: f.trackingNumbers,
            urls: f.trackingUrls,
          },
          estimatedDeliveryAt: f.estimatedDeliveryAt
            ? f.estimatedDeliveryAt.toISOString()
            : null,
          deliveredAt: f.deliveredAt ? f.deliveredAt.toISOString() : null,
        })),
      };
    }),
});
