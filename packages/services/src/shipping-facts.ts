/**
 * Per-tenant shipping facts — the store's own shipping grounding facts,
 * structured. Sibling of `returnsFacts`; "Facts" (what the agent may quote) is
 * deliberately not "Policy" (the walls the runtime enforces).
 *
 * Stored as a `shippingFacts` sub-object of `tenants.settings` (JSONB) and
 * edited on the dashboard's Knowledge base page. It sits alongside the free-text
 * knowledge documents rather than inside them because two of its fields are
 * *decisions*, not prose: `deliveryTime` is the window an agent judges lateness
 * against, and `delayedAfterDays` is the exact point past which a shipment gets
 * a fulfillmentOperator check. Retrieval over pasted prose is a poor way to fetch a number
 * a policy depends on, so these travel to the agent as a trusted prompt header
 * (and as `@shipping.*` references inside scenario notes).
 *
 * The block is all-or-nothing: `decodeShippingFacts` returns `null` unless the
 * three required fields are present and valid. A half-written block must not
 * hand the agent a delivery window it can act on — the fallback is
 * `knowledge.search` over the merchant's documents, which is where the guidance
 * lived before this existed.
 *
 * Shipped as `shippingProfile` and renamed to `shippingFacts` on 2026-07-11 for
 * vocabulary consistency. Migration `0046_shipping_facts_rename` moves the
 * persisted key, so there is exactly one name for the block and no read-time
 * fallback.
 */

/** Who settles customs / import duties on an international order. */
export type CustomsDutiesPayer = "customer" | "merchant" | "not_applicable";

export interface ShippingFacts {
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
   * opens a fulfillmentOperator check beyond this point, so it is a merchant decision and
   * never a value we infer.
   */
  readonly delayedAfterDays: number;
  /**
   * Whole days in transit past which the store STOPS waiting on a missing
   * package and makes the customer whole (refund / reship), as opposed to
   * `delayedAfterDays` which only opens a fulfillmentOperator check. A second, later point
   * on the same timeline. Optional — `null` when the merchant hasn't said, so
   * the `delivery_issue` / `missing-package-agent` notes fall back to
   * `knowledge.search` for it rather than to a made-up number.
   */
  readonly lostPackageInvestigationDays: number | null;
}

/** Absent until the merchant fills the form. */
export const defaultShippingFacts: ShippingFacts | null = null;

/** Per-field cap for the free-text fields, enforced by truncation on read. */
export const SHIPPING_FACTS_TEXT_MAX = 200;

/** Upper bound on the delay threshold — a year of transit is already absurd. */
export const SHIPPING_FACTS_MAX_DELAY_DAYS = 365;

const CUSTOMS_PAYERS: ReadonlySet<string> = new Set([
  "customer",
  "merchant",
  "not_applicable",
]);

/** Trimmed + capped, or null when absent / blank / not a string. */
const text = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v === "" ? null : v.slice(0, SHIPPING_FACTS_TEXT_MAX);
};

/**
 * A sane whole day-count, clamped to the cap — or null when absent / not a
 * positive integer. For the OPTIONAL day thresholds that degrade individually
 * (a bad value drops to null rather than nulling the whole block).
 */
const optionalDays = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= 1
    ? Math.min(raw, SHIPPING_FACTS_MAX_DELAY_DAYS)
    : null;

/**
 * Decode the tenant's "can update the shipping address after fulfillment"
 * capability from the RAW `tenants.settings` object (not the shippingFacts
 * block). It states literally that the store can update an order's shipping
 * address after the order is fulfilled — nothing more. When `true`, the
 * `order.update_shipping_address` tool skips its fulfilled-order refusal and
 * the agent's facts header carries the line. Edited on the dashboard's
 * Knowledge base page next to the shipping facts, but deliberately NOT inside
 * the all-or-nothing `shippingFacts` block: a merchant who never filled
 * delivery times can still declare the capability. Only a literal `true`
 * counts — anything else (absent, malformed, truthy junk) is `false`, since
 * the default must stay the safe refusal.
 */
export const decodeAddressUpdateAfterFulfillment = (
  rawSettings: unknown,
): boolean =>
  typeof rawSettings === "object" &&
  rawSettings !== null &&
  !Array.isArray(rawSettings) &&
  (rawSettings as Record<string, unknown>)[
    "addressUpdateAfterFulfillment"
  ] === true;

/**
 * Decode the `shippingFacts` block of `tenants.settings`.
 *
 * Returns `null` for anything short of a usable block: not an object, or any of
 * `processingTime` / `deliveryTime` / `delayedAfterDays` missing or invalid.
 * Optional fields degrade to `null` individually — an unrecognised customs payer
 * is dropped rather than coerced, since guessing `customer` would have the agent
 * tell a buyer they owe duties the merchant actually absorbs.
 */
export const decodeShippingFacts = (
  raw: unknown,
): ShippingFacts | null => {
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
    delayedAfterDays: Math.min(days, SHIPPING_FACTS_MAX_DELAY_DAYS),
    lostPackageInvestigationDays: optionalDays(r["lostPackageInvestigationDays"]),
  };
};
