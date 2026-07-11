import { Effect, Schema } from "effect";
import {
  defineTool,
  OrderId,
  ToolOutputInvalid,
  type ShopifyOrder,
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

/**
 * The flattened, LLM-facing order shape returned by `shopify.get_order`.
 * Exported so sibling tools that surface an order (e.g.
 * `shopify.find_customer_order`) project the order identically — one
 * shape the specialists learn once.
 */
export const ShopifyOrderOutput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  confirmationNumber: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  /**
   * The Shopify customer GID the order was placed under, or null for a guest
   * order. Exposed so the runtime can match the order to the ticket's resolved
   * customer (order → customer, not order-email → thread-email) when deciding
   * the order/customer-mismatch flag. An opaque id — harmless to the model.
   */
  customerId: Schema.NullOr(Schema.String),
  fulfillmentStatus: Schema.NullOr(Schema.String),
  financialStatus: Schema.NullOr(Schema.String),
  // ISO timestamp when the order was cancelled, or null if still open.
  // Lets a specialist see an already-cancelled order before proposing
  // another cancellation.
  cancelledAt: Schema.NullOr(Schema.String),
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
      unitPrice: Schema.NullOr(Money),
      productId: Schema.NullOr(Schema.String),
    }),
  ),
  fulfillments: Schema.Array(Fulfillment),
});

const Output = ShopifyOrderOutput;

/**
 * Flatten a domain `ShopifyOrder` into the LLM-facing `ShopifyOrderOutput`
 * shape (ISO-string dates, nested tracking object). Shared by every tool
 * that returns an order so the projection stays in one place.
 */
export const projectShopifyOrder = (
  order: ShopifyOrder,
): Schema.Schema.Type<typeof ShopifyOrderOutput> => ({
  id: order.id,
  name: order.name,
  confirmationNumber: order.confirmationNumber,
  email: order.email,
  customerId: order.customerId,
  fulfillmentStatus: order.fulfillmentStatus,
  financialStatus: order.financialStatus,
  cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
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
    unitPrice: li.unitPrice ?? null,
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
});

export const shopifyGetOrder = defineTool({
  name: "shopify.get_order",
  description:
    "Look up a Shopify order. Accepts the merchant-facing order name (`#1001`, with or without the leading `#`), the customer-facing confirmation number (a random alphanumeric code like `XPAV284CT` printed on the order confirmation email), the numeric Shopify internal id, or a `gid://shopify/Order/...` GID. Pass whatever identifier the customer gave verbatim, the tool tries the order name first and falls back to a confirmation-number lookup automatically. Returns the order (including its `confirmationNumber`) with line items, each line item's `unitPrice` when available, fulfillment status, financial status, and tracking info. Use this to answer order questions and to price one-line-item partial refund offers without inferring from the order total.",
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

      const wrapErr = (e: { readonly _tag: string }) =>
        new ToolOutputInvalid({
          tool: "shopify.get_order",
          issues: [e._tag],
        });
      const notFound = Effect.fail(
        new ToolOutputInvalid({
          tool: "shopify.get_order",
          issues: ["OrderNotFound"],
        }),
      );

      // Branch on input shape:
      //   - `gid://shopify/Order/<n>` → direct id lookup (the rare power-
      //     user ticket where the caller already has a GID).
      //   - any other string → resolve by *search*. Try the order name
      //     first (`findOrderByName`) because customers usually quote
      //     `#1001`; on a miss, fall back to a confirmation-number lookup
      //     (`findOrderByConfirmationNumber`) since some customers only
      //     have the `XPAV284CT`-style code from their confirmation email.
      //     Confirmation codes are alphanumeric and never match a name
      //     search, so the two legs don't collide. Both searches return
      //     `null` (not a typed error) on a miss — only after BOTH miss do
      //     we surface `OrderNotFound`, the same failure shape as a by-id
      //     miss.
      const raw = input.orderId;
      const order = raw.startsWith("gid://")
        ? yield* shopify
            .getOrder(ctx.tenantId, OrderId(raw))
            .pipe(Effect.mapError(wrapErr))
        : yield* shopify.findOrderByName(ctx.tenantId, raw).pipe(
            Effect.flatMap((o) =>
              o
                ? Effect.succeed(o)
                : shopify.findOrderByConfirmationNumber(ctx.tenantId, raw),
            ),
            Effect.mapError(wrapErr),
            Effect.flatMap((o) => (o ? Effect.succeed(o) : notFound)),
          );
      return projectShopifyOrder(order);
    }),
});
