// ============================================================
// Dashboard "Issue refund" — operator acts on an agent recommendation
// ============================================================
//
// When the refund-review agent takes PATH B (recommend a refund, then draft a
// reply for approval) it calls the read-only `refund.recommend` tool — which
// issues nothing. The operator approving the reply sees the recommendation, but
// until now had no way to actually issue the money from the dashboard; their
// only path was Shopify admin. This closes that gap: the operator clicks
// "Issue refund" on the case and we run the same refund the agent would have via
// `refund.create` — operator authorization (the `refunds.issue` permission)
// stands in for the agent-approval flow.
//
// This is the dependency-injected orchestration core: pure async over its deps
// so it unit-tests with fakes (no Shopify, no Effect layer). The HTTP handler
// wires `loadOrder` / `refund` / `recordIssued` to the real services.
//
// Guards (in order): the amount must parse to a positive number → resolve the
// case's order → it must exist → it must not be fully refunded already → the
// requested currency must match the order's (we never invent an FX rate). Only
// then do we move money. A refund failure is reported so the UI can surface it
// (and NOT claim the customer was refunded); post-refund bookkeeping (audit) is
// best-effort — once Shopify has moved the money, an audit hiccup must not tell
// the operator the refund failed.

export interface RefundMoney {
  /** Decimal string, matching ShopifyMoney. */
  readonly amount: string;
  readonly currencyCode: string;
}

/** The order resolved from the case context, narrowed to what we need. */
export interface IssueRefundOrderView {
  /** Shopify order GID. */
  readonly orderId: string;
  readonly currencyCode: string;
  readonly financialStatus: string | null;
}

export interface IssuedRefund {
  /** Shopify refund GID. */
  readonly id: string;
  readonly amount: RefundMoney;
  /** ISO-8601 refund timestamp. */
  readonly createdAt: string;
}

export type IssueRefundOutcome =
  | {
      readonly kind: "issued";
      readonly refundId: string;
      readonly amount: RefundMoney;
      readonly createdAt: string;
    }
  | { readonly kind: "invalid_amount" }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "already_refunded" }
  | {
      readonly kind: "currency_mismatch";
      readonly orderCurrency: string;
      readonly requestedCurrency: string;
    }
  | { readonly kind: "refund_failed"; readonly error: string };

export interface IssueCaseRefundOptions {
  /** The amount the operator is issuing (the recommended amount). */
  readonly amount: RefundMoney;
  /** Resolve the case's order; `null` = no order could be resolved. */
  readonly loadOrder: () => Promise<IssueRefundOrderView | null>;
  /** Issue the refund through Shopify. Throws/rejects on failure. */
  readonly refund: (args: {
    readonly orderId: string;
    readonly amount: RefundMoney;
  }) => Promise<IssuedRefund>;
  /** Best-effort post-refund bookkeeping (audit). */
  readonly recordIssued: (refund: IssuedRefund) => Promise<void>;
}

const positiveAmount = (raw: string): boolean => {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0;
};

export const issueCaseRefund = async (
  opts: IssueCaseRefundOptions,
): Promise<IssueRefundOutcome> => {
  if (!positiveAmount(opts.amount.amount)) return { kind: "invalid_amount" };

  const order = await opts.loadOrder();
  if (!order) return { kind: "order_not_found" };
  if (order.financialStatus === "refunded") return { kind: "already_refunded" };
  if (
    order.currencyCode.toUpperCase() !==
    opts.amount.currencyCode.toUpperCase()
  ) {
    return {
      kind: "currency_mismatch",
      orderCurrency: order.currencyCode,
      requestedCurrency: opts.amount.currencyCode,
    };
  }

  let refund: IssuedRefund;
  try {
    refund = await opts.refund({
      orderId: order.orderId,
      amount: opts.amount,
    });
  } catch (cause) {
    return {
      kind: "refund_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  try {
    await opts.recordIssued(refund);
  } catch (cause) {
    // The money already moved — never downgrade a real refund to a failure over
    // bookkeeping. Surface it in logs for follow-up.
    // eslint-disable-next-line no-console
    console.error("[issue refund] post-refund bookkeeping failed", {
      refundId: refund.id,
      cause,
    });
  }

  return {
    kind: "issued",
    refundId: refund.id,
    amount: refund.amount,
    createdAt: refund.createdAt,
  };
};
