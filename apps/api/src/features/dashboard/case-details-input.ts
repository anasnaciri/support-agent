import {
  looksLikeGid,
  looksLikeOrderName,
} from "./shopify-panels.js";

// Shaping + validation for the case-page "edit details" pencil (Customer / Order
// cards). A manager hand-corrects the customer email/name or the order ref the
// agent couldn't extract (e.g. a legacy relay case stamped `mailer@shopify.com`).
// The values are authenticated but still untrusted over the wire, so validate
// defensively before they touch `case.context`.

// Same shape the one-off backfill script accepts — a pragmatic "looks like an
// address" check, not full RFC 5322. Good enough to keep obvious garbage
// (`mailer@shopify`, `not-an-email`) out of the reply-recipient slot.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Trim + lowercase a customer email, returning null when it doesn't look like a
 * real address (so the handler can 400 rather than stamp junk as the reply
 * target). Lowercased because that's how the runtime + Shopify lookups compare.
 */
export const normalizeCustomerEmail = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
};

/** Trim a customer display name; null when empty or not a string. */
export const normalizeCustomerName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Which Shopify lookup resolves a merchant-typed order ref — mirrors
 * `resolveOrderForContext`: a GID is fetched exactly, a `#1001`/`1001` name is
 * searched by name, anything else is treated as a confirmation code.
 */
export const classifyOrderRef = (
  ref: string,
): "gid" | "name" | "confirmation" =>
  looksLikeGid(ref) ? "gid" : looksLikeOrderName(ref) ? "name" : "confirmation";
