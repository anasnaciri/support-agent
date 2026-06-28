import type { RefundLineItemInput } from "@support-agent/services";

// Shaping helpers for the dashboard refund modal's request body. The restock
// selection comes from an authenticated operator, but it's still untrusted
// input over the wire — parse it defensively so a malformed entry drops out
// rather than failing (or worse, mis-issuing) the whole refund.

const RESTOCK_TYPES = new Set(["RETURN", "CANCEL", "NO_RESTOCK"]);

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/**
 * Parse the modal's `lineItems` payload into `RefundLineItemInput[]`. Drops
 * entries missing a line id, with a non-positive / non-integer quantity, or an
 * unknown `restockType`. A `NO_RESTOCK` line never carries a `locationId`
 * (Shopify rejects it); `RETURN` / `CANCEL` keep theirs when present.
 */
export const parseRefundLineItems = (
  raw: unknown,
): RefundLineItemInput[] => {
  if (!Array.isArray(raw)) return [];
  const out: RefundLineItemInput[] = [];
  for (const entry of raw) {
    const r = asRecord(entry);
    if (!r) continue;
    const lineItemId = r["lineItemId"];
    const quantity = r["quantity"];
    const restockType = r["restockType"];
    if (typeof lineItemId !== "string" || lineItemId.length === 0) continue;
    if (
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      continue;
    }
    if (typeof restockType !== "string" || !RESTOCK_TYPES.has(restockType)) {
      continue;
    }
    const locationRaw = r["locationId"];
    const locationId =
      restockType !== "NO_RESTOCK" &&
      typeof locationRaw === "string" &&
      locationRaw.length > 0
        ? locationRaw
        : null;
    out.push({
      lineItemId,
      quantity,
      restockType: restockType as RefundLineItemInput["restockType"],
      locationId,
    });
  }
  return out;
};

/**
 * Parse the optional shipping-refund money. Returns null when absent or
 * malformed (no shipping refund), or when the amount isn't a positive number.
 */
export const parseRefundShipping = (
  raw: unknown,
): { readonly amount: string; readonly currencyCode: string } | null => {
  const r = asRecord(raw);
  if (!r) return null;
  const amount = r["amount"];
  const currencyCode = r["currencyCode"];
  if (typeof amount !== "string" || typeof currencyCode !== "string") {
    return null;
  }
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { amount, currencyCode };
};
