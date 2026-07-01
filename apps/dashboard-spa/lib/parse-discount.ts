// Pure parsing for the discount-policy save. Framework-free so it's
// unit-testable; the server action is thin glue around it. Mirrors the
// refund-policy parse-thresholds module, but a discount carries TWO
// threshold pairs (percentage + fixed-amount) plus a forced expiry cap.

import type { DiscountPolicyMode } from "@support-agent/dashboard-contracts";

/**
 * Parse a percentage string ("10", "12.5") to a number in [0, 100].
 * Returns null on malformed input (negative, > 100, > 2 fractional digits).
 */
export const parsePercentage = (raw: string): number | null => {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
};

/**
 * Parse a major-units decimal string ("5.00", "50") into minor units
 * (500, 5000). Returns null on malformed input.
 */
export const parseMajorUnits = (raw: string): number | null => {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

/** Parse an integer day count in [1, 365]; null otherwise. */
export const parseValidityDays = (raw: string): number | null => {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isInteger(n) || n < 1 || n > 365) return null;
  return n;
};

export type DiscountResolution =
  | {
      readonly ok: true;
      readonly askPct: number;
      readonly maxPct: number;
      readonly askMinor: number;
      readonly maxMinor: number;
    }
  | { readonly ok: false; readonly error: "bad_percentage" | "bad_amount" | "bad_order" };

/**
 * Resolve the threshold values to persist for a save in `mode`.
 *
 * - `thresholds` mode: every input governs behaviour — malformed input or an
 *   ask > max ordering is a validation error, never coalesced.
 * - `always_ask` / `always_deny`: the thresholds are dormant. A parseable
 *   value is persisted (so switching back to `thresholds` restores the
 *   merchant's numbers), but an unparseable one falls back PER FIELD to the
 *   stored value — a stale tab must never silently zero saved thresholds.
 */
export const resolveDiscountThresholds = (args: {
  readonly mode: DiscountPolicyMode;
  readonly askPctRaw: string;
  readonly maxPctRaw: string;
  readonly askAmtRaw: string;
  readonly maxAmtRaw: string;
  readonly stored: {
    readonly askPct: number;
    readonly maxPct: number;
    readonly askMinor: number;
    readonly maxMinor: number;
  };
}): DiscountResolution => {
  const askPct = parsePercentage(args.askPctRaw);
  const maxPct = parsePercentage(args.maxPctRaw);
  const askMinor = parseMajorUnits(args.askAmtRaw);
  const maxMinor = parseMajorUnits(args.maxAmtRaw);

  if (args.mode === "thresholds") {
    if (askPct === null || maxPct === null) {
      return { ok: false, error: "bad_percentage" };
    }
    if (askMinor === null || maxMinor === null) {
      return { ok: false, error: "bad_amount" };
    }
    if (askPct > maxPct || askMinor > maxMinor) {
      return { ok: false, error: "bad_order" };
    }
    return { ok: true, askPct, maxPct, askMinor, maxMinor };
  }

  return {
    ok: true,
    askPct: askPct ?? args.stored.askPct,
    maxPct: maxPct ?? args.stored.maxPct,
    askMinor: askMinor ?? args.stored.askMinor,
    maxMinor: maxMinor ?? args.stored.maxMinor,
  };
};
