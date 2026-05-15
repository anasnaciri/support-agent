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
    }),
  ),
  fulfillments: Schema.Array(Fulfillment),
});

export const shopifyGetOrder = defineTool({
  name: "shopify.get_order",
  description:
    "Look up a Shopify order by its id or GraphQL gid. Returns the order with line items, fulfillment status, financial status, and tracking info. Use this to answer 'where is my order?' questions.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const order = yield* shopify
        .getOrder(ctx.tenantId, OrderId(input.orderId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "shopify.get_order",
                issues: [e._tag],
              }),
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
