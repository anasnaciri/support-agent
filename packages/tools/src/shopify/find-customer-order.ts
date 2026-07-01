import { Effect, Schema } from "effect";
import { CustomerId, defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { CaseRepository, ShopifyService } from "@support-agent/services";
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
    "Look up the writer's orders. When the case has already resolved the customer (matched by their email, phone, or name), this lists THAT customer's orders — so it finds them even if an order was placed under a different email. Otherwise it falls back to the email you pass (the `from=` value in the `[Thread context: ...]` header). Use this ONLY when the case has no identified order id and the customer did not give an order number. Returns `status`: `single` when there is exactly one order (then `order` holds it — treat it as the order they're asking about; do NOT ask them for an order number), `none` when no orders match, or `multiple` when there is more than one (then ask which order). A returned order is already known to belong to the resolved customer.",
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
      const repo = yield* CaseRepository;

      // Prefer the case's RESOLVED customer (resolved by email/phone/name →
      // `shopifyCustomerId`): list that account's orders so we find them even
      // when placed under a different email. Fall back to the by-email lookup
      // when no customer resolved (guest, or Shopify connected after the case
      // was created). Best-effort read — a repo miss just uses the email path.
      const resolvedCustomerId = yield* repo.getById(ctx.caseId).pipe(
        Effect.map((c) => {
          const id = (c.context as Record<string, unknown>)["shopifyCustomerId"];
          return typeof id === "string" && id.length > 0 ? id : null;
        }),
        Effect.catchAll(() => Effect.succeed(null)),
      );

      const orders = yield* (
        resolvedCustomerId
          ? shopify.findOrdersByCustomerId(
              ctx.tenantId,
              CustomerId(resolvedCustomerId),
              LOOKUP_LIMIT,
            )
          : shopify.findOrdersByEmail(ctx.tenantId, email, LOOKUP_LIMIT)
      ).pipe(
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
