import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";
import { ShopifyOrderOutput, projectShopifyOrder } from "./get-order.js";

const Input = Schema.Struct({
  email: Schema.String,
});

const Output = Schema.Struct({
  // `single`   — the customer has exactly one order; `order` is it.
  // `none`     — no orders found under this email; `order` is null.
  // `multiple` — more than one order; `order` is null, `orderCount` says
  //              how many were seen (capped at the lookup limit).
  status: Schema.Literal("single", "none", "multiple"),
  orderCount: Schema.Number,
  order: Schema.NullOr(ShopifyOrderOutput),
});

// We only need enough rows to tell "exactly one" from "more than one".
const LOOKUP_LIMIT = 10;

export const shopifyFindCustomerOrder = defineTool({
  name: "shopify.find_customer_order",
  description:
    "Look up a customer's orders by the email address they are writing from (the `from=` value in the `[Thread context: ...]` header). Use this ONLY when the case has no identified order id and the customer did not give an order number. Returns `status`: `single` when the customer has exactly one order (then `order` holds it — treat it as the order they're asking about; do NOT ask them for an order number), `none` when no orders match the email, or `multiple` when there is more than one (then ask which order). Because the lookup is keyed on the customer's own email, a returned order is already known to belong to them.",
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
      const email = input.email.trim();
      if (email.length === 0) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: "shopify.find_customer_order",
            issues: ["email_required"],
          }),
        );
      }

      const shopify = yield* ShopifyService;
      const orders = yield* shopify
        .findOrdersByEmail(ctx.tenantId, email, LOOKUP_LIMIT)
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "shopify.find_customer_order",
                issues: [e._tag],
              }),
          ),
        );

      if (orders.length === 0) {
        return { status: "none" as const, orderCount: 0, order: null };
      }
      if (orders.length === 1) {
        return {
          status: "single" as const,
          orderCount: 1,
          order: projectShopifyOrder(orders[0]!),
        };
      }
      return {
        status: "multiple" as const,
        orderCount: orders.length,
        order: null,
      };
    }),
});
