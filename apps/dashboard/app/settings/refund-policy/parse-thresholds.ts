// Pure threshold parsing for the refund-policy save (U10). Framework-free so
// it's unit-testable; the server action in actions.ts is thin glue around it.

import type { RefundPolicyMode } from "@support-agent/dashboard-contracts";

/**
 * Parse a major-units decimal string ("25.00", "200") into minor units
 * (2500, 20000). Returns null on malformed input. Rejects negatives, multiple
 * dots, and more than 2 fractional digits (no sub-cent thresholds).
 */
export const parseMajorUnits = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
};

export type ThresholdResolution =
  | { readonly ok: true; readonly askMinor: number; readonly denyMinor: number }
  | { readonly ok: false; readonly error: "bad_amount" | "bad_order" };

/**
 * Resolve the threshold pair to persist for a save in `mode`.
 *
 * - `thresholds` mode: both inputs govern behaviour — malformed input or
 *   ask > deny is a validation error, never coalesced.
 * - `always_ask` / `always_deny`: the thresholds are dormant. A parseable
 *   value is persisted (so switching back to `thresholds` restores the
 *   merchant's numbers), but an unparseable one falls back PER FIELD to the
 *   stored value — a stale tab must never silently zero saved thresholds.
 */
export const resolveRefundThresholds = (args: {
  readonly mode: RefundPolicyMode;
  readonly askRaw: string;
  readonly denyRaw: string;
  readonly stored: { readonly askMinor: number; readonly denyMinor: number };
}): ThresholdResolution => {
  const askParsed = parseMajorUnits(args.askRaw);
  const denyParsed = parseMajorUnits(args.denyRaw);

  if (args.mode === "thresholds") {
    if (askParsed === null || denyParsed === null) {
      return { ok: false, error: "bad_amount" };
    }
    if (askParsed > denyParsed) {
      return { ok: false, error: "bad_order" };
    }
    return { ok: true, askMinor: askParsed, denyMinor: denyParsed };
  }

  return {
    ok: true,
    askMinor: askParsed ?? args.stored.askMinor,
    denyMinor: denyParsed ?? args.stored.denyMinor,
  };
};
