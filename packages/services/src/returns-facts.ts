/**
 * Per-tenant returns facts — the store's own returns/refund grounding facts,
 * structured.
 *
 * Stored as a `returnsFacts` sub-object of `tenants.settings` (JSONB) and edited
 * on the dashboard's Knowledge base page, alongside the free-text knowledge
 * documents and the `shippingFacts` block. It sits here rather than inside the
 * pasted prose because these are the numbers/enums a returns scenario *branches*
 * on: `returnWindowDays` is the window an agent judges an in-policy return
 * against, and the payer / method / processing-time are the values it quotes
 * verbatim to the customer. Retrieval over prose is a poor way to fetch a value a
 * reply depends on, so these travel to the agent as a trusted prompt header (and,
 * later, as `@returns.*` references inside scenario notes).
 *
 * Only `returnWindowDays` is all-or-nothing: `decodeReturnsFacts` returns `null`
 * unless it is present and a sane whole number of days. A half-written block must
 * not hand the agent a return window it can act on — the fallback is
 * `knowledge.search` over the merchant's documents, which is where the guidance
 * lived before this existed. Every OTHER field degrades to `null` individually
 * and is simply omitted from the header when unset — same discipline as
 * `decodeShippingFacts`.
 */

/** Who pays to ship a return back to the store. */
export type ReturnShippingPayer = "customer" | "merchant" | "depends";

/** How a refund is issued. */
export type RefundMethod = "original" | "store_credit" | "customer_choice";

export interface ReturnsFacts {
  /**
   * Whole days after delivery within which a return is accepted. The one
   * all-or-nothing field — a returns scenario branches on it, so it is a
   * merchant decision and never a value we infer.
   */
  readonly returnWindowDays: number;
  /** Who pays return shipping. Optional — `null` when the merchant hasn't said. */
  readonly returnShippingPayer: ReturnShippingPayer | null;
  /** How a refund is issued. Optional — `null` when unset. */
  readonly refundMethod: RefundMethod | null;
  /**
   * Free-text processing time the agent quotes, e.g. "5–7 business days after we
   * receive the item". Optional — `null` when unset.
   */
  readonly refundProcessingTime: string | null;
}

/** Absent until the merchant fills the form. */
export const defaultReturnsFacts: ReturnsFacts | null = null;

/** Per-field cap for the free-text field, enforced by truncation on read. */
export const RETURNS_FACTS_TEXT_MAX = 200;

/** Upper bound on the return window — a year is already absurdly generous. */
export const RETURNS_FACTS_MAX_WINDOW_DAYS = 365;

const RETURN_SHIPPING_PAYERS: ReadonlySet<string> = new Set([
  "customer",
  "merchant",
  "depends",
]);

const REFUND_METHODS: ReadonlySet<string> = new Set([
  "original",
  "store_credit",
  "customer_choice",
]);

/** Trimmed + capped, or null when absent / blank / not a string. */
const text = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v === "" ? null : v.slice(0, RETURNS_FACTS_TEXT_MAX);
};

/**
 * Decode the `returnsFacts` block of `tenants.settings`.
 *
 * Returns `null` for anything short of a usable block: not an object, or
 * `returnWindowDays` missing / not a sane whole number of days. Optional fields
 * degrade to `null` individually — an unrecognised payer or refund method is
 * dropped rather than coerced, since guessing (say) `customer` would have the
 * agent tell a buyer they owe return shipping the merchant actually covers.
 */
export const decodeReturnsFacts = (raw: unknown): ReturnsFacts | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const days = r["returnWindowDays"];
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
    return null;
  }

  const payer = r["returnShippingPayer"];
  const method = r["refundMethod"];
  return {
    returnWindowDays: Math.min(days, RETURNS_FACTS_MAX_WINDOW_DAYS),
    returnShippingPayer:
      typeof payer === "string" && RETURN_SHIPPING_PAYERS.has(payer)
        ? (payer as ReturnShippingPayer)
        : null,
    refundMethod:
      typeof method === "string" && REFUND_METHODS.has(method)
        ? (method as RefundMethod)
        : null,
    refundProcessingTime: text(r["refundProcessingTime"]),
  };
};
