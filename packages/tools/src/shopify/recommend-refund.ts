import { Effect, Schema } from "effect";
import {
  OrderId,
  defineTool,
  ToolOutputInvalid,
  type ShopifyMoney,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import {
  ShopifyService,
  TenantRepository,
  defaultRefundPolicy,
  parseRefundAmount,
  type CustomerRefundHistory,
  type RefundPolicy,
} from "@support-agent/services";

// ============================================================
// Input / Output schemas
// ============================================================

const Money = Schema.Struct({
  amount: Schema.String,
  currencyCode: Schema.String,
});

const Input = Schema.Struct({
  orderId: Schema.String,
});

const Output = Schema.Struct({
  recommendation: Schema.Literal(
    "full_refund",
    "partial_refund",
    "deny",
    "investigate",
  ),
  // Suggested refund amount. Null when the recommendation is `deny`
  // (nothing to refund) or `investigate` (operator decides).
  // **Always carries the order's own currency** — never invented.
  amount: Schema.NullOr(Money),
  reasoning: Schema.String,
  // Free-form risk tags from the customer-history aggregation. Empty
  // array when nothing notable; operator-readable shorthand for the
  // dashboard's approval card to surface.
  riskFlags: Schema.Array(Schema.String),
});

// ============================================================
// Pure recommendation logic (exported for unit testing)
// ============================================================

export interface RecommendationDecision {
  readonly recommendation:
    | "full_refund"
    | "partial_refund"
    | "deny"
    | "investigate";
  readonly amount: ShopifyMoney | null;
  readonly reasoning: string;
  readonly riskFlags: ReadonlyArray<string>;
}

const DAYS_MS = 24 * 60 * 60 * 1000;
const RETURN_WINDOW_DAYS = 30;
const NEW_CUSTOMER_DAYS = 30;
const FREQUENT_REFUNDER_RATIO = 0.3;
// $500 in minor units. Compared against the order's currency only when
// `totalPrice.currencyCode` matches `refundPolicy.currencyCode` — if
// they differ we don't flag (cross-currency LTV math is not meaningful
// without an FX rate).
const HIGH_LTV_THRESHOLD_MINOR = 50_000;

export const computeRiskFlags = (
  history: CustomerRefundHistory,
  now: Date,
  orderCurrency: string,
  policyCurrency: string,
): ReadonlyArray<string> => {
  const flags: string[] = [];
  if (history.ordersCount === 1) {
    flags.push("first_order");
  }
  if (history.ordersCount > 0) {
    const ratio = history.refundedOrdersCount / history.ordersCount;
    if (ratio > FREQUENT_REFUNDER_RATIO) {
      flags.push("frequent_refunder");
    }
  }
  if (history.firstOrderAt) {
    const ageMs = now.getTime() - history.firstOrderAt.getTime();
    if (ageMs < NEW_CUSTOMER_DAYS * DAYS_MS) {
      flags.push("new_customer");
    }
  }
  // LTV flag is only meaningful when the refund total's currency
  // matches the policy currency — otherwise we'd be comparing apples
  // to oranges. Skip silently rather than inventing a conversion.
  if (
    history.totalRefundedAmount &&
    history.totalRefundedAmount.currencyCode === policyCurrency.toUpperCase() &&
    orderCurrency.toUpperCase() === policyCurrency.toUpperCase()
  ) {
    const parsed = Number.parseFloat(history.totalRefundedAmount.amount);
    if (Number.isFinite(parsed)) {
      const minor = Math.round(parsed * 100);
      if (minor > HIGH_LTV_THRESHOLD_MINOR) {
        flags.push("high_ltv");
      }
    }
  }
  return flags;
};

/**
 * Apply the pure recommendation rules to an order + tenant policy +
 * customer history snapshot. Exported so the rule table can be
 * unit-tested without spinning up the full tool layer.
 */
export const computeRefundRecommendation = (input: {
  readonly order: ShopifyOrder;
  readonly policy: RefundPolicy;
  readonly history: CustomerRefundHistory;
  readonly now: Date;
}): RecommendationDecision => {
  const { order, policy, history, now } = input;
  const orderCurrency = order.totalPrice.currencyCode;
  const riskFlags = computeRiskFlags(
    history,
    now,
    orderCurrency,
    policy.currencyCode,
  );

  // Rule 1: already refunded → nothing to do.
  if (order.financialStatus === "refunded") {
    return {
      recommendation: "deny",
      amount: null,
      reasoning: "Order already fully refunded.",
      riskFlags,
    };
  }
  // Rule 2: partially refunded → human owns the remainder.
  if (order.financialStatus === "partially_refunded") {
    return {
      recommendation: "investigate",
      amount: null,
      reasoning:
        "Order partially refunded; case-by-case review needed for the remainder.",
      riskFlags,
    };
  }
  // Rule 3: not paid → unusual state, escalate.
  if (order.financialStatus !== "paid") {
    return {
      recommendation: "investigate",
      amount: null,
      reasoning: `Unusual financial status (${order.financialStatus ?? "unknown"}).`,
      riskFlags,
    };
  }

  // Rule 4: outside the merchant's return window.
  const deliveredAt = order.fulfillments
    .map((f) => f.deliveredAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (
    deliveredAt &&
    now.getTime() - deliveredAt.getTime() > RETURN_WINDOW_DAYS * DAYS_MS
  ) {
    return {
      recommendation: "deny",
      amount: null,
      reasoning: `Return window expired (delivered more than ${RETURN_WINDOW_DAYS} days ago).`,
      riskFlags,
    };
  }

  // Rule 5: amount vs tenant refund policy. Cross-currency degrades
  // to investigate — we never auto-recommend across currencies.
  const parsedAmount = parseRefundAmount({ amount: order.totalPrice });
  if (parsedAmount === null) {
    return {
      recommendation: "investigate",
      amount: null,
      reasoning: "Could not parse the order total — manual review needed.",
      riskFlags,
    };
  }
  if (parsedAmount.currencyCode !== policy.currencyCode.toUpperCase()) {
    return {
      recommendation: "investigate",
      amount: order.totalPrice,
      reasoning: `Order currency (${parsedAmount.currencyCode}) differs from policy currency (${policy.currencyCode}) — manual review for cross-currency refund.`,
      riskFlags,
    };
  }
  if (parsedAmount.amountMinorUnits > policy.denyAboveMinorUnits) {
    return {
      recommendation: "investigate",
      amount: order.totalPrice,
      reasoning: `Order total exceeds tenant's hard cap (${policy.denyAboveMinorUnits / 100} ${policy.currencyCode}).`,
      riskFlags,
    };
  }
  if (parsedAmount.amountMinorUnits <= policy.askAboveMinorUnits) {
    return {
      recommendation: "full_refund",
      amount: order.totalPrice,
      reasoning: "Within auto-approve zone — full refund recommended.",
      riskFlags,
    };
  }
  // Mid-zone (between askAbove and denyAbove): recommend full refund;
  // the operator is the one approving anyway.
  return {
    recommendation: "full_refund",
    amount: order.totalPrice,
    reasoning:
      "Mid-zone amount — recommend full refund with operator review.",
    riskFlags,
  };
};

// ============================================================
// Tool
// ============================================================

export const shopifyRefundRecommend = defineTool({
  name: "refund.recommend",
  description:
    "Recommend a refund decision for an existing Shopify order, without issuing anything. Returns a structured `{ recommendation, amount, reasoning, riskFlags }` payload: 'full_refund' / 'partial_refund' / 'deny' / 'investigate'. The agent calls this BEFORE drafting a customer reply on PATH B (when refund.create is blocked by the threshold) so the operator approving the draft sees the structured assessment alongside the prose. Read-only — `defaultPermission: allow`, no side effects, no `requiredConnectorScopes` (uses the same scopes shopify.get_order + shopify.get_customer already need).",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const shopify = yield* ShopifyService;
      const tenants = yield* TenantRepository;

      // Fetch order, policy, and customer history in parallel.
      // Customer history is best-effort — if the customer id isn't on
      // the order or the lookup fails, we fall back to a zero history
      // so the rule table still runs.
      const order = yield* shopify
        .getOrder(ctx.tenantId, OrderId(input.orderId))
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "refund.recommend",
                issues: [e._tag],
              }),
          ),
        );

      const settings = yield* tenants
        .getSettings(ctx.tenantId)
        .pipe(
          Effect.catchAll(() =>
            Effect.succeed({ refundPolicy: defaultRefundPolicy } as const),
          ),
        );
      const policy = settings.refundPolicy;

      const history: CustomerRefundHistory = order.customerId
        ? yield* shopify
            .getCustomerRefundHistory(ctx.tenantId, order.customerId)
            .pipe(
              Effect.catchAll(() =>
                Effect.succeed({
                  ordersCount: 0,
                  refundedOrdersCount: 0,
                  totalRefundedAmount: null,
                  firstOrderAt: null,
                } as CustomerRefundHistory),
              ),
            )
        : ({
            ordersCount: 0,
            refundedOrdersCount: 0,
            totalRefundedAmount: null,
            firstOrderAt: null,
          } as CustomerRefundHistory);

      const decision = computeRefundRecommendation({
        order,
        policy,
        history,
        now: new Date(),
      });

      return {
        recommendation: decision.recommendation,
        amount: decision.amount
          ? {
              amount: decision.amount.amount,
              currencyCode: decision.amount.currencyCode,
            }
          : null,
        reasoning: decision.reasoning,
        riskFlags: decision.riskFlags,
      };
    }),
});
