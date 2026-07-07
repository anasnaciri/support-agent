import { Effect, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import { ShopifyService, TenantRepository } from "@support-agent/services";

const Money = Schema.Struct({
  // Decimal string, matching ShopifyMoney shape (no floats — money rounds
  // badly). This is the order's refundable total; it gates the cancel
  // against the per-tenant refund policy and is recorded for the audit log.
  amount: Schema.String,
  currencyCode: Schema.String,
});

const Input = Schema.Struct({
  // Same id shapes `shopify.get_order` accepts. By the time you're
  // cancelling, the agent has already fetched the order and has the GID in
  // scope; order *names* like `#1001` are NOT accepted.
  orderId: Schema.String,
  // The order's refundable total (read off `shopify.get_order`'s
  // `totalPrice`). Shopify computes the ACTUAL refund when it cancels — this
  // figure exists so the permission layer can gate the cancel against the
  // tenant's refund thresholds (same as `refund.create`) and so the audit
  // log records what the agent expected to be refunded.
  amount: Money,
  // Free-text reason recorded on the order timeline as a staff note.
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});

const Output = Schema.Struct({
  orderId: Schema.String,
  // Shopify's async job GID; null if not returned. The cancellation +
  // refund are processed asynchronously, so there is no refund record here.
  jobId: Schema.NullOr(Schema.String),
  accepted: Schema.Boolean,
});

export const shopifyOrderCancel = defineTool({
  name: "order.cancel",
  description:
    "Cancel an existing Shopify order AND refund it. Use this ONLY for an order that has NOT shipped yet (fulfillment unfulfilled and not already cancelled) — Shopify rejects cancelling a fulfilled order. The `orderId` must be a Shopify GID (`gid://shopify/Order/...`) or a numeric internal id (auto-wrapped); order names like `#1001` are NOT accepted — call `shopify.get_order` first to resolve the order and read its fulfillment status. `amount` is the order's refundable total (its `totalPrice`) as a decimal string + ISO currency code; the cancellation refunds the captured amount and `amount` is what the per-tenant refund policy is checked against. `reason` is recorded as a staff note on the order. Whether the items are returned to inventory is a store setting, not chosen here. Permission policy: defaultPermission is `ask` and the runtime overlays the SAME per-tenant refund threshold as `refund.create` (the cancel issues a refund), so small cancellations may auto-run and large ones escalate for approval. This cancels an order and moves real money: never call it twice for the same request — if the result is unclear, check the order state via `shopify.get_order` instead of retrying.",
  displayDescription:
    "The agent cancels an unshipped order and refunds it. Governed by your refund-policy thresholds.",
  // Cancelling issues a refund, so it's governed by the refund policy — not a
  // simple per-agent ask/auto toggle. Same control as `refund.create`.
  tenantControl: "refund-threshold",
  inputSchema: Input,
  outputSchema: Output,
  risk: "money",
  defaultPermission: "ask",
  sideEffectClass: "financial",
  // Shopify gates `orderCancel` behind `write_orders` — the SAME scope
  // refunds already require, so no new scope is requested. Declaring it lets
  // PermissionService deny the call before execute when the merchant hasn't
  // granted it (the agent then drafts a reply for human review instead of
  // crashing on a 403 mid-flight).
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["write_orders"],
  },
  // Bind retries together: a stable key over the order lets the runtime's
  // execution-marker dedup catch LLM re-emissions and redeliveries.
  idempotencyKey: (input) => `cancel:${input.orderId}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;

      // Whether to return the cancelled items to inventory is a merchant
      // setting (the dashboard "Order cancellations" restock checkbox), not
      // an agent choice. Read it; on a settings miss restock (the safe
      // default for stores that track stock).
      const tenants = yield* TenantRepository;
      const settings = yield* tenants
        .getSettings(ctx.tenantId)
        .pipe(Effect.catchAll(() => Effect.succeed({ cancellationRestock: true } as const)));
      const restock = settings.cancellationRestock !== false;

      const cancellation = yield* shopify
        .cancelOrder(ctx.tenantId, {
          orderId: OrderId(input.orderId),
          // Customer-requested cancellation. The store-setting restock and
          // refund-true are forced here; the agent never chooses them.
          reason: "customer",
          refund: true,
          restock,
          // The agent sends its own customer reply — don't have Shopify also
          // email a cancellation notice.
          notifyCustomer: false,
          staffNote: input.reason ?? null,
          idempotencyKey: ctx.callId,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "order.cancel",
                issues: [e._tag],
              }),
          ),
        );

      return {
        orderId: cancellation.orderId,
        jobId: cancellation.jobId,
        accepted: cancellation.accepted,
      };
    }),
});
