import { Clock, Effect, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
} from "@support-agent/agent-core";
import {
  ShopifyService,
  TenantRepository,
  defaultDiscountPolicy,
} from "@support-agent/services";

const Input = Schema.Struct({
  // The order this goodwill coupon relates to. Accepts a GID or numeric
  // id (same shapes `shopify.get_order` accepts); the tool resolves the
  // order so it can LOCK the coupon to that order's customer — the agent
  // never supplies a customer email, so it can't redirect the coupon to a
  // different address than the order's owner.
  orderId: Schema.String,
  valueType: Schema.Literal("percentage", "fixed_amount"),
  // Decimal string. For `percentage` it's a whole percent ("10" ⇒ 10% off);
  // for `fixed_amount` it's a money amount in `currencyCode`.
  value: Schema.String,
  // Required for `fixed_amount` (the order's currency); ignored for
  // `percentage`. Surfaced on the input so the permission layer can gate
  // fixed-amount coupons against the per-tenant cap before execute.
  currencyCode: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});

const Output = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  title: Schema.String,
  valueType: Schema.Literal("percentage", "fixed_amount"),
  value: Schema.String,
  currencyCode: Schema.NullOr(Schema.String),
  customerId: Schema.String,
  usageLimit: Schema.Number,
  endsAt: Schema.String,
  createdAt: Schema.String,
});

// Customer-facing code prefix. Neutral goodwill framing; the suffix is a
// deterministic 6-char token (no ambiguous 0/O/1/I/L) derived from the
// tool call id, so re-running the same call (idempotency) yields the same
// code and tests are deterministic.
const CODE_PREFIX = "THANKS";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const discountCodeFromSeed = (seed: string): string => {
  let h = 2166136261 >>> 0;
  const chars: string[] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j) + i;
      h = Math.imul(h, 16777619) >>> 0;
    }
    chars.push(CODE_ALPHABET[h % CODE_ALPHABET.length]!);
  }
  return `${CODE_PREFIX}-${chars.join("")}`;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const shopifyDiscountCreate = defineTool({
  name: "discount.create",
  description:
    "Create a single-use discount (coupon) code as a goodwill / service-recovery gesture, locked to the customer on an existing order. You choose only the `valueType` (`percentage` or `fixed_amount`) and `value`; everything else is fixed by the store's policy and CANNOT be set here — the code is single-use, usable only by the order's customer (a leaked code is worthless), non-combinable with other discounts, applies to the whole next order, and expires after the store's configured window. The `orderId` must be a Shopify GID (`gid://shopify/Order/...`) or numeric id — call `shopify.get_order` first; order names like `#1001` are NOT accepted. For `fixed_amount`, set `currencyCode` to the order's `totalPrice.currencyCode` (it must match the order's currency); for `percentage`, omit it and pass `value` as a whole percent (e.g. \"15\" for 15% off). Permission policy: defaultPermission is `ask` and the runtime overlays the tenant's discount thresholds (small discounts auto-run, larger ones escalate for approval, over-cap ones are denied). If it denies, draft a reply for human review instead. This issues a real coupon: never call it twice for the same request.",
  displayName: "Issue a discount code",
  displayDescription:
    "The agent issues a single-use coupon code, locked to the customer, as a goodwill gesture. Governed by your discount-policy thresholds.",
  tenantControl: "discount-threshold",
  inputSchema: Input,
  outputSchema: Output,
  risk: "money",
  defaultPermission: "ask",
  sideEffectClass: "external_state",
  // Shopify gates `discountCodeBasicCreate` behind `write_discounts`.
  // Declaring it lets PermissionService deny before execute when the
  // merchant hasn't granted the scope (the agent then drafts a reply
  // instead of crashing on a 403 mid-flight) — same pattern as refunds.
  requiredConnectorScopes: {
    provider: "shopify",
    scopes: ["write_discounts"],
  },
  // Dedup re-emissions / redeliveries: a stable key over the proposed
  // coupon means the runtime's execution-marker dedup catches a second
  // emission before a duplicate code is created.
  idempotencyKey: (input) =>
    `discount:${input.orderId}:${input.valueType}:${input.value}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      // Defensive value validation (the policy gate already ran, but a
      // nonsensical value should never reach Shopify).
      const numeric = Number.parseFloat(input.value);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: "discount.create",
            issues: ["value must be a positive decimal string"],
          }),
        );
      }
      if (input.valueType === "percentage" && numeric > 100) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: "discount.create",
            issues: ["percentage value must not exceed 100"],
          }),
        );
      }

      const shopify = yield* ShopifyService;

      // Resolve the order to LOCK the coupon to its customer. The customer
      // GID comes from the order, never from agent-supplied input — so the
      // agent can't redirect the coupon to a different address.
      const order = yield* shopify
        .getOrder(ctx.tenantId, OrderId(input.orderId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "discount.create",
                issues: [e._tag],
              }),
          ),
        );
      if (!order.customerId) {
        return yield* Effect.fail(
          new ToolOutputInvalid({
            tool: "discount.create",
            issues: [
              "order has no associated customer record; cannot lock a coupon to a customer",
            ],
          }),
        );
      }

      // Fixed-amount coupons must be in the order's currency. We require
      // the agent to pass it (so the permission layer can gate it) AND
      // verify it here against the order — a mismatch is a hard stop.
      let currencyCode: string | null = null;
      if (input.valueType === "fixed_amount") {
        const orderCcy = order.totalPrice.currencyCode;
        if (
          !input.currencyCode ||
          input.currencyCode.toUpperCase() !== orderCcy.toUpperCase()
        ) {
          return yield* Effect.fail(
            new ToolOutputInvalid({
              tool: "discount.create",
              issues: [
                `fixed_amount currencyCode must match the order currency (${orderCcy})`,
              ],
            }),
          );
        }
        currencyCode = orderCcy.toUpperCase();
      }

      // The expiry window is a store policy, not an agent choice. Read it
      // and force endsAt = now + maxValidityDays. On a settings miss fall
      // back to the conservative default window.
      const tenants = yield* TenantRepository;
      const settings = yield* tenants
        .getSettings(ctx.tenantId)
        .pipe(
          Effect.catchAll(() =>
            Effect.succeed({ discountPolicy: defaultDiscountPolicy } as const),
          ),
        );
      const maxValidityDays = settings.discountPolicy.maxValidityDays;
      const now = yield* Clock.currentTimeMillis;
      const endsAt = new Date(now + maxValidityDays * MS_PER_DAY);

      const discount = yield* shopify
        .createDiscountCode(ctx.tenantId, {
          customerId: order.customerId,
          code: discountCodeFromSeed(ctx.callId),
          title: `Goodwill discount for ${order.name} (case ${ctx.caseId})`,
          valueType: input.valueType,
          value: input.value,
          currencyCode,
          endsAt,
          usageLimit: 1,
          appliesOncePerCustomer: true,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "discount.create",
                issues: [e._tag],
              }),
          ),
        );

      return {
        id: discount.id,
        code: discount.code,
        title: discount.title,
        valueType: discount.valueType,
        value: discount.value,
        currencyCode: discount.currencyCode,
        customerId: discount.customerId,
        usageLimit: discount.usageLimit,
        endsAt: discount.endsAt.toISOString(),
        createdAt: discount.createdAt.toISOString(),
      };
    }),
});
