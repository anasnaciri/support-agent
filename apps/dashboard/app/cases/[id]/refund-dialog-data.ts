import type {
  ShopifyRefundLineItem,
} from "@support-agent/agent-core";
// Type-only import: erased at build, so api-client's `server-only` marker never
// reaches the client bundle that imports this module.
import type { RefundLineItemPayload } from "@/lib/api-client";

// Pure logic behind the Shopify-style refund modal — the amount math, the
// default selection, and the restock-type derivation. Kept out of the client
// component so it's unit-tested. The backend issues amount + restock-lines
// refunds via Shopify's refundCreate; this only prices and shapes the operator's
// selection. Shopify re-validates the issued amount, so the rounding here never
// decides what actually moves.

export interface RefundSelection {
  /** Quantity of this line to refund (0 ⇒ excluded). */
  readonly quantity: number;
  /** Whether to restock the returned units (only honored when restockable). */
  readonly restock: boolean;
}

export type RefundSelections = Readonly<Record<string, RefundSelection>>;

const num = (s: string): number => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Default selection mirroring Shopify's refund page: every refundable line at
 * full quantity, with restock pre-checked for items Shopify reports as
 * restockable.
 */
export const defaultSelections = (
  lineItems: ReadonlyArray<ShopifyRefundLineItem>,
): RefundSelections =>
  Object.fromEntries(
    lineItems.map((li) => [
      li.lineItemId,
      { quantity: li.refundableQuantity, restock: li.restockable },
    ]),
  );

/** Clamp a requested quantity into `[0, max]` and floor it to an integer. */
export const clampQuantity = (requested: number, max: number): number =>
  !Number.isFinite(requested) || requested <= 0
    ? 0
    : requested > max
      ? max
      : Math.floor(requested);

export interface RefundTotals {
  /** Σ unit price × qty across selected lines (pre-tax) — the "Items subtotal". */
  readonly itemsSubtotal: number;
  /** Total units selected (the "(N)" next to the subtotal). */
  readonly itemsCount: number;
  readonly tax: number;
  readonly shipping: number;
  /** itemsSubtotal + tax + shipping — the suggested "Refund total". */
  readonly refundTotal: number;
}

export const computeRefundTotals = (input: {
  readonly lineItems: ReadonlyArray<ShopifyRefundLineItem>;
  readonly selections: RefundSelections;
  readonly refundShipping: boolean;
  readonly shippingRefundable: string;
}): RefundTotals => {
  let itemsSubtotal = 0;
  let tax = 0;
  let itemsCount = 0;
  for (const li of input.lineItems) {
    const qty = input.selections[li.lineItemId]?.quantity ?? 0;
    if (qty <= 0) continue;
    itemsCount += qty;
    itemsSubtotal += num(li.unitPrice.amount) * qty;
    tax += num(li.unitTax.amount) * qty;
  }
  const shipping = input.refundShipping ? num(input.shippingRefundable) : 0;
  return {
    itemsSubtotal,
    itemsCount,
    tax,
    shipping,
    refundTotal: itemsSubtotal + tax + shipping,
  };
};

/**
 * The Shopify restock type for a line given the operator's restock toggle:
 * fulfilled items come back as `RETURN`, unfulfilled as `CANCEL`, and an
 * un-restocked refund is `NO_RESTOCK`. Shopify rejects the wrong type for a
 * line's fulfillment state, so this mapping isn't cosmetic.
 */
export const resolveRestockType = (
  line: ShopifyRefundLineItem,
  restock: boolean,
): RefundLineItemPayload["restockType"] =>
  !restock ? "NO_RESTOCK" : line.fulfilled ? "RETURN" : "CANCEL";

/**
 * Shape the operator's selection into the wire payload. Lines with zero
 * selected quantity drop out; restock is forced off for non-restockable items;
 * a NO_RESTOCK line never carries a location.
 */
export const buildRefundLineItems = (input: {
  readonly lineItems: ReadonlyArray<ShopifyRefundLineItem>;
  readonly selections: RefundSelections;
  readonly locationId: string | null;
}): RefundLineItemPayload[] => {
  const out: RefundLineItemPayload[] = [];
  for (const li of input.lineItems) {
    const sel = input.selections[li.lineItemId];
    if (!sel || sel.quantity <= 0) continue;
    const restock = sel.restock && li.restockable;
    const restockType = resolveRestockType(li, restock);
    out.push({
      lineItemId: li.lineItemId,
      quantity: sel.quantity,
      restockType,
      locationId:
        restockType === "NO_RESTOCK"
          ? null
          : (input.locationId ?? li.restockLocationId),
    });
  }
  return out;
};

/** Format a number as a 2dp money string (for input values + display). */
export const money2 = (n: number): string => n.toFixed(2);

export type RefundAmountValidation =
  | { readonly ok: true; readonly amount: string }
  | {
      readonly ok: false;
      readonly reason: "empty" | "not_a_number" | "not_positive" | "exceeds_max";
    };

/**
 * Validate the operator-entered refund amount against the maximum refundable
 * Shopify reported. The backend re-validates (and Shopify is final authority),
 * but gating the button here gives immediate feedback and blocks an obvious
 * over-refund before it round-trips.
 */
export const validateRefundAmount = (
  raw: string,
  maximumRefundable: string,
): RefundAmountValidation => {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return { ok: false, reason: "not_a_number" };
  if (n <= 0) return { ok: false, reason: "not_positive" };
  const max = Number.parseFloat(maximumRefundable);
  if (Number.isFinite(max) && n > max + 1e-9) {
    return { ok: false, reason: "exceeds_max" };
  }
  return { ok: true, amount: trimmed };
};
