/**
 * Per-tenant shipping profile — the store's own shipping facts, structured.
 *
 * Stored as a `shippingProfile` sub-object of `tenants.settings` (JSONB) and
 * edited on the dashboard's Knowledge base page. It sits alongside the free-text
 * knowledge documents rather than inside them because two of its fields are
 * *decisions*, not prose: `deliveryTime` is the window an agent judges lateness
 * against, and `delayedAfterDays` is the exact point past which a shipment gets
 * a supplier check. Retrieval over pasted prose is a poor way to fetch a number
 * a policy depends on, so these travel to the agent as a trusted prompt header.
 *
 * The profile is all-or-nothing: `decodeShippingProfile` returns `null` unless
 * the three required fields are present and valid. A half-written block must not
 * hand the agent a delivery window it can act on — the fallback is
 * `knowledge.search` over the merchant's documents, which is where the guidance
 * lived before this existed.
 */

/** Who settles customs / import duties on an international order. */
export type CustomsDutiesPayer = "customer" | "merchant" | "not_applicable";

export interface ShippingProfile {
  /** How long before an order leaves the warehouse, e.g. "1–2 business days". */
  readonly processingTime: string;
  /** Typical ship→deliver window, e.g. "7–12 days". The lateness yardstick. */
  readonly deliveryTime: string;
  /** Free-text cost + free-shipping threshold. Optional. */
  readonly shippingCost: string | null;
  /** Optional — `null` when the merchant hasn't said. */
  readonly customsDuties: CustomsDutiesPayer | null;
  /**
   * Whole days in transit past which a shipment counts as delayed. The agent
   * opens a supplier check beyond this point, so it is a merchant decision and
   * never a value we infer.
   */
  readonly delayedAfterDays: number;
}

/** Absent until the merchant fills the form. */
export const defaultShippingProfile: ShippingProfile | null = null;

/** Per-field cap for the free-text fields, enforced by truncation on read. */
export const SHIPPING_PROFILE_TEXT_MAX = 200;

/** Upper bound on the delay threshold — a year of transit is already absurd. */
export const SHIPPING_PROFILE_MAX_DELAY_DAYS = 365;

const CUSTOMS_PAYERS: ReadonlySet<string> = new Set([
  "customer",
  "merchant",
  "not_applicable",
]);

/** Trimmed + capped, or null when absent / blank / not a string. */
const text = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v === "" ? null : v.slice(0, SHIPPING_PROFILE_TEXT_MAX);
};

/**
 * Decode the `shippingProfile` block of `tenants.settings`.
 *
 * Returns `null` for anything short of a usable profile: not an object, or any
 * of `processingTime` / `deliveryTime` / `delayedAfterDays` missing or invalid.
 * Optional fields degrade to `null` individually — an unrecognised customs payer
 * is dropped rather than coerced, since guessing `customer` would have the agent
 * tell a buyer they owe duties the merchant actually absorbs.
 */
export const decodeShippingProfile = (
  raw: unknown,
): ShippingProfile | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const processingTime = text(r["processingTime"]);
  const deliveryTime = text(r["deliveryTime"]);
  if (!processingTime || !deliveryTime) return null;

  const days = r["delayedAfterDays"];
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
    return null;
  }

  const customs = r["customsDuties"];
  return {
    processingTime,
    deliveryTime,
    shippingCost: text(r["shippingCost"]),
    customsDuties:
      typeof customs === "string" && CUSTOMS_PAYERS.has(customs)
        ? (customs as CustomsDutiesPayer)
        : null,
    delayedAfterDays: Math.min(days, SHIPPING_PROFILE_MAX_DELAY_DAYS),
  };
};
