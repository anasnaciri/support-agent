import { Effect, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ShopifyService } from "@support-agent/services";

const Money = Schema.Struct({
  // Decimal string, matching ShopifyMoney shape. We don't accept a
  // number here on purpose: floats round badly for money and we don't
  // want the model emitting `12.989999`.
  amount: Schema.String,
  currencyCode: Schema.String,
});

const Input = Schema.Struct({
  // Accept the same id shapes shopify.get_order accepts. Live impl
  // requires a GID, so we wrap plain numeric ids; order *names* like
  // `#1001` are NOT accepted here — by the time you're refunding, the
  // agent has already fetched the order and has the GID in scope.
  orderId: Schema.String,
  amount: Money,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  notifyCustomer: Schema.optional(Schema.Boolean),
});

const Output = Schema.Struct({
  id: Schema.String,
  orderId: Schema.String,
  amount: Money,
  note: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export const shopifyRefundCreate = defineTool({
  name: "refund.create",
  description:
    "Issue a refund against an existing Shopify order. Amount-only — refunds the specified amount against the order's primary refundable transaction. The `orderId` must be a Shopify GID (`gid://shopify/Order/...`) or a numeric internal id (which is auto-wrapped); order names like `#1001` are NOT accepted — call `shopify.get_order` first to resolve to a GID. `amount` is a decimal string + ISO currency code; the currency must match the order's currency. `reason` is recorded as the refund note. `notifyCustomer` defaults to false — set true to have Shopify email the customer the refund confirmation. Permission policy: defaultPermission is `ask` and the runtime overlays a per-tenant amount threshold on top (small refunds auto-run, large refunds escalate). The tool is idempotency-safe: re-running with the same orderId + amount + currency does NOT double-refund — the runtime ties (caseId, callId) to a single execution and Shopify rejects exact duplicates within a short window.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "money",
  defaultPermission: "ask",
  sideEffectClass: "financial",
  // Shopify gates the `refundCreate` mutation behind `write_orders`.
  // Declaring it here lets `PermissionService` deny the call before
  // execute when the merchant hasn't granted that scope — the refund-
  // review-agent then falls back to PATH B (draft a reply for human
  // approval) instead of attempting the call and crashing on a 403
  // from Shopify mid-flight.
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["write_orders"],
  },
  // Bind retries together. (caseId, callId) is the primary dedup at the
  // runtime layer; this is a secondary safety net for re-emissions from
  // the LLM (same input, fresh callId) — Shopify itself doesn't surface
  // a refund-level idempotency-key header today, but a stable
  // `clientMutationId`-style hash here at least lets the tool reject
  // identical retries that bubble up through different code paths
  // (e.g. an approve email click after a manual restart).
  idempotencyKey: (input) =>
    `refund:${input.orderId}:${input.amount.amount}:${input.amount.currencyCode}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const refund = yield* shopify
        .refundOrder(ctx.tenantId, {
          orderId: OrderId(input.orderId),
          amount: {
            amount: input.amount.amount,
            currencyCode: input.amount.currencyCode,
          },
          note: input.reason ?? null,
          notifyCustomer: input.notifyCustomer ?? false,
          idempotencyKey: ctx.callId,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "refund.create",
                issues: [e._tag],
              }),
          ),
        );
      return {
        id: refund.id,
        orderId: refund.orderId,
        amount: {
          amount: refund.amount.amount,
          currencyCode: refund.amount.currencyCode,
        },
        note: refund.note,
        createdAt: refund.createdAt.toISOString(),
      };
    }),
});
