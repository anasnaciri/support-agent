// ============================================================
// Dashboard "Cancel order" — operator cancels the ticket's order
// ============================================================
//
// The counterpart to the agent's `order.cancel` tool, run under operator
// authority instead of the refund-policy thresholds: the customer writes in
// before the parcel ships, the operator cancels from the ticket page's Order
// card rather than leaving for the Shopify admin. Gated on `refunds.issue` —
// a cancel refunds captured money by default, so it is governed by the same
// permission that lets a member move money.
//
// This is the dependency-injected orchestration core (same shape as
// `issueTicketRefund` / `updateTicketShippingAddress`): pure async over its
// deps so it unit-tests with fakes. The HTTP handler wires `loadOrder` /
// `cancel` / `recordCancelled` to the live services.
//
// Guards (in order): resolve the ticket's order → it must exist → it must not
// already carry a `cancelledAt` (Shopify rejects a second cancel, and we must
// never re-refund). Shopify is the authority on everything else — a fulfilled
// order comes back as a rejection, surfaced as `cancel_failed` so the UI can
// say so instead of claiming the order was cancelled. Post-cancel bookkeeping
// (audit) is best-effort: once Shopify has queued the cancellation, an audit
// hiccup must not tell the operator it failed.

/** The Shopify `OrderCancelReason` values, as the mutation accepts them. */
const CANCEL_REASONS = [
  "customer",
  "declined",
  "fraud",
  "inventory",
  "staff",
  "other",
] as const;

export type CancelOrderReason = (typeof CANCEL_REASONS)[number];

/** What the operator asked for, as the confirm dialog submits it. */
export interface CancelOrderRequest {
  /** Refund the captured amount. Default true — cancelling normally repays. */
  readonly refund: boolean;
  /** Return the cancelled units to inventory. Default true. */
  readonly restock: boolean;
  readonly reason: CancelOrderReason;
  /** Recorded on the order timeline as a staff note. */
  readonly staffNote: string | null;
}

/** The order resolved from the ticket context, narrowed to what we need. */
export interface CancelTicketOrderOrderView {
  /** Shopify order GID. */
  readonly orderId: string;
  /** ISO-8601 timestamp when already cancelled, else null. */
  readonly cancelledAt: string | null;
}

export type CancelOrderOutcome =
  | {
      readonly kind: "cancelled";
      readonly orderId: string;
      /** Shopify's async job GID, null when not returned. */
      readonly jobId: string | null;
      readonly accepted: true;
    }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "already_cancelled" }
  | { readonly kind: "cancel_failed"; readonly error: string };

export interface CancelTicketOrderOptions {
  readonly request: CancelOrderRequest;
  /** Resolve the ticket's order; `null` = no order bound to the ticket. */
  readonly loadOrder: () => Promise<CancelTicketOrderOrderView | null>;
  /**
   * Cancel through Shopify. Resolves with the async job id and whether
   * Shopify accepted the request. Throws/rejects on failure.
   */
  readonly cancel: (args: {
    readonly orderId: string;
    readonly request: CancelOrderRequest;
  }) => Promise<{ readonly jobId: string | null; readonly accepted: boolean }>;
  /** Best-effort post-cancel bookkeeping (audit). */
  readonly recordCancelled: (args: {
    readonly orderId: string;
    readonly jobId: string | null;
    readonly request: CancelOrderRequest;
  }) => Promise<void>;
}

const isCancelReason = (v: unknown): v is CancelOrderReason =>
  typeof v === "string" &&
  (CANCEL_REASONS as ReadonlyArray<string>).includes(v);

/**
 * Map a JSON body to a cancel request. Returns `null` when `reason` is present
 * but is not one Shopify accepts (the handler answers 400) — everything else
 * has a safe default.
 *
 * The booleans fail SAFE for the customer: only an explicit `false` withholds
 * the refund or the restock, so a malformed flag repays rather than keeps the
 * money.
 */
export const parseCancelOrderBody = (
  body: Record<string, unknown>,
): CancelOrderRequest | null => {
  const rawReason = body["reason"];
  if (rawReason !== undefined && !isCancelReason(rawReason)) return null;

  const rawNote = body["staffNote"];
  const note = typeof rawNote === "string" ? rawNote.trim() : "";

  return {
    refund: body["refund"] === false ? false : true,
    restock: body["restock"] === false ? false : true,
    reason: rawReason ?? "customer",
    staffNote: note.length > 0 ? note : null,
  };
};

export const cancelTicketOrder = async (
  opts: CancelTicketOrderOptions,
): Promise<CancelOrderOutcome> => {
  const order = await opts.loadOrder();
  if (!order) return { kind: "order_not_found" };
  if (order.cancelledAt !== null) return { kind: "already_cancelled" };

  let result: { readonly jobId: string | null; readonly accepted: boolean };
  try {
    result = await opts.cancel({
      orderId: order.orderId,
      request: opts.request,
    });
  } catch (cause) {
    return {
      kind: "cancel_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Shopify's Live impl turns `orderCancelUserErrors` into a thrown error, so
  // this is belt-and-braces — but reporting "cancelled" for a request Shopify
  // did not accept would tell the operator the customer was refunded when they
  // were not.
  if (!result.accepted) {
    return { kind: "cancel_failed", error: "Shopify did not accept the cancellation" };
  }

  try {
    await opts.recordCancelled({
      orderId: order.orderId,
      jobId: result.jobId,
      request: opts.request,
    });
  } catch (cause) {
    // The order is already cancelled on the store — never report failure over
    // bookkeeping. Surface it in logs for follow-up.
    // eslint-disable-next-line no-console
    console.error("[cancel order] post-cancel bookkeeping failed", { cause });
  }

  return {
    kind: "cancelled",
    orderId: order.orderId,
    jobId: result.jobId,
    accepted: true,
  };
};
