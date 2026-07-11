import { Context, Data, Effect, Layer } from "effect";
import type { TenantId } from "@support-agent/agent-core";

import type { BlockedSenders } from "./blocked-senders.js";
import type { ShippingFacts } from "./shipping-facts.js";
import type { ReturnsFacts } from "./returns-facts.js";

// ============================================================
// TenantRepository
// ============================================================
//
// Read access to the `tenants` table. Today the only field anyone
// needs through the Tag is the operator's notification email (where
// approval-link mail goes); the interface stays narrow so adding new
// columns doesn't ripple. When the dashboard lands and tenants gain a
// full settings UI, we widen this in one place — `db/...-live` follows.
//
// Why a separate Tag (not just DbClient + drizzle inline): the
// PlatformMailServiceLive lives in `providers`, and CLAUDE.md keeps
// `providers` free of Postgres/db dependencies. Tags in services let
// `providers` consume tenant data without crossing the layer rule.

/**
 * Per-tenant policy for the `refund.create` tool. Thresholds are stored
 * in minor units (cents, pence, ...) so the comparison is integer-clean
 * regardless of decimal formatting. `currencyCode` declares the currency
 * the thresholds apply to; refunds in another currency fall back to
 * `ask` defensively (a future widen can support per-currency thresholds).
 *
 * Zones:
 *   - amountMinorUnits ≤ askAboveMinorUnits        → allow (agent auto-runs)
 *   - askAboveMinorUnits < amountMinorUnits ≤ denyAboveMinorUnits → ask
 *   - amountMinorUnits > denyAboveMinorUnits       → deny (escalate)
 *
 * `mode` selects how the policy behaves and sits above the zones:
 *   - `thresholds`  — the amount-based zones above (the normal ticket)
 *   - `always_ask`  — every refund waits for human approval (never
 *     auto-allows), no matter the amount; the thresholds are ignored
 *   - `always_deny` — every refund is blocked regardless of amount,
 *     currency, or the static decision (the agent can never refund)
 *
 * In the two non-threshold modes the thresholds are retained (so the
 * merchant can switch back to `thresholds` and get them back) but unused.
 * Absent/undefined ⇒ `thresholds` (back-compat with legacy rows).
 *
 * Defaults are conservative — see `defaultRefundPolicy` below.
 */
export type RefundPolicyMode = "thresholds" | "always_ask" | "always_deny";

export interface RefundPolicy {
  readonly askAboveMinorUnits: number;
  readonly denyAboveMinorUnits: number;
  readonly currencyCode: string;
  /** How the policy behaves. Absent/undefined ⇒ `"thresholds"`. */
  readonly mode?: RefundPolicyMode;
}

/**
 * Hard fallback used when a tenant has never configured a refund policy.
 * Picks ISO USD and a conservative $0 ask threshold so every refund is
 * gated by default — operators must explicitly raise the threshold to
 * give the agent autonomy. Better to over-ask on day 1 than auto-refund
 * something the merchant didn't intend.
 */
export const defaultRefundPolicy: RefundPolicy = {
  askAboveMinorUnits: 0,
  denyAboveMinorUnits: 50_000, // $500 hard cap
  currencyCode: "USD",
  mode: "thresholds",
};

/**
 * Per-tenant policy for the `discount.create` tool (goodwill coupon
 * codes). Same shape philosophy as {@link RefundPolicy}: the agent
 * proposes a discount value and this policy gates it into
 * allow / ask / deny — it never silently rewrites the value (a coupon
 * that differs from what the agent told the customer would be worse than
 * an escalation). The agent never sets the other coupon parameters: the
 * `discount.create` tool forces single-use, locks the code to the ticket
 * customer, makes it non-combinable, and caps the expiry at
 * `maxValidityDays` — see the tool for the full guardrail list.
 *
 * Percentage discounts (the common service-recovery gesture) gate on the
 * percentage zones; fixed-amount discounts gate on minor-unit zones in
 * `currencyCode`, with a currency mismatch falling back to `ask`
 * (mirrors the refund policy exactly).
 *
 * Zones (percentage):
 *   - percentage ≤ askAbovePercentage              → allow (agent auto-runs)
 *   - askAbovePercentage < percentage ≤ maxPercentage → ask
 *   - percentage > maxPercentage                   → deny (escalate)
 *
 * Zones (fixed_amount), in `currencyCode`:
 *   - amountMinorUnits ≤ askAboveFixedAmountMinorUnits        → allow
 *   - askAbove… < amount ≤ maxFixedAmountMinorUnits           → ask
 *   - amountMinorUnits > maxFixedAmountMinorUnits             → deny
 *
 * `maxValidityDays` is a hard forced cap on the coupon's expiry window —
 * the tool always sets `endsAt = now + maxValidityDays`, never longer.
 *
 * `mode` sits above the zones, identical to refunds:
 *   - `thresholds`  — the zones above (normal ticket)
 *   - `always_ask`  — every coupon waits for human approval
 *   - `always_deny` — the agent can never issue a coupon
 *
 * Absent/undefined `mode` ⇒ `thresholds`. Defaults are conservative —
 * see `defaultDiscountPolicy`.
 */
export type DiscountPolicyMode = "thresholds" | "always_ask" | "always_deny";

export interface DiscountPolicy {
  readonly askAbovePercentage: number;
  readonly maxPercentage: number;
  readonly askAboveFixedAmountMinorUnits: number;
  readonly maxFixedAmountMinorUnits: number;
  readonly currencyCode: string;
  readonly maxValidityDays: number;
  /** How the policy behaves. Absent/undefined ⇒ `"thresholds"`. */
  readonly mode?: DiscountPolicyMode;
}

/**
 * Hard fallback used when a tenant has never configured a discount
 * policy. Conservative on every axis: ≤10% auto-issues, 10–20% asks a
 * human, >20% is denied; every fixed-amount coupon asks (askAbove = 0)
 * up to a $50 hard cap; coupons expire in 30 days. Operators raise these
 * to give the agent more autonomy.
 */
export const defaultDiscountPolicy: DiscountPolicy = {
  askAbovePercentage: 10,
  maxPercentage: 20,
  askAboveFixedAmountMinorUnits: 0,
  maxFixedAmountMinorUnits: 5_000, // $50 hard cap
  currencyCode: "USD",
  maxValidityDays: 30,
  mode: "thresholds",
};

// ============================================================
// ResolutionPolicy — merchant-configurable per-scenario playbooks
// ============================================================
//
// A "scenario" is a kind of customer situation (delivery problem, refund
// request, ...). For each, the merchant declares — as DATA, not code — which
// remedy tools the scenario-resolution agent may use and whether each is
// automatic or needs human approval (`enabledActions`, the HARD gate), how to
// handle the supplier (`supplierMode`), and free-text guidance (`notes`, the
// only soft, LLM-interpreted field). `recognition` is fed to triage so it can
// match an inbound message to the scenario.
//
// Baseline tools (order lookup, knowledge.search, reply, ask_customer,
// update_context, merchant.notify) are ALWAYS available and are NEVER listed in
// `enabledActions` — the envelope unions them back in. `enabledActions` only
// configures the remedy/write tools (refund, discount, ...). Spending caps
// (RefundPolicy / DiscountPolicy) still gate the money tools on top.

export type ScenarioActionPermission = "allow" | "ask";

export interface ScenarioAction {
  readonly tool: string;
  readonly permission: ScenarioActionPermission;
}

export type SupplierMode = "escalate_and_wait" | "notify_and_proceed" | "none";

export interface ScenarioPolicy {
  /** Stable id. Built-ins are fixed; custom scenarios are merchant-defined. */
  readonly key: string;
  /** Merchant-facing name. */
  readonly label: string;
  /** "When this applies" — injected into triage to match inbound messages. */
  readonly recognition?: string;
  /** Seeded + (for built-ins) backed by a tuned flow, vs merchant-authored. */
  readonly builtin: boolean;
  /**
   * Whether triage may route NEW tickets to the resolution agent for this
   * scenario. Optional for back-compat (absent ⇒ enabled); the decoder
   * normalizes it, so a decoded scenario always carries a boolean. A disabled
   * scenario is simply not offered to triage — in-flight tickets keep theirs.
   */
  readonly enabled?: boolean;
  /** Remedy tools this scenario may use + auto/ask each. Absent ⇒ denied. */
  readonly enabledActions: ReadonlyArray<ScenarioAction>;
  readonly supplierMode: SupplierMode;
  /** Free-text playbook injected verbatim into the prompt (soft layer). */
  readonly notes?: string;
}

export interface ResolutionPolicy {
  readonly scenarios: ReadonlyArray<ScenarioPolicy>;
}

/**
 * Seeded built-in scenarios, pre-filled to match today's specialist behavior.
 * Used as the defaults-on-read fallback when a tenant has never configured a
 * resolution policy. Money tools default to `ask` (gated); supplier handling
 * mirrors today (delivery/damage escalate + wait). Baseline tools are omitted
 * on purpose (always-on).
 */
export const defaultResolutionPolicy: ResolutionPolicy = {
  scenarios: [
    {
      key: "where_is_order",
      label: "Where is my order?",
      recognition:
        "Customer is asking where their order is, or for its tracking / delivery status.",
      builtin: true,
      enabled: true,
      enabledActions: [],
      // A status question that turns out to be a shipping problem is handled
      // by the GENERAL re-classification rule (the agent re-stamps
      // scenarioKey to delivery_issue and follows that playbook), so this
      // scenario stays supplier-free for the plain answer-the-status case.
      supplierMode: "none",
      notes:
        "Look up the order, check tracking if available, and tell the customer the status. " +
        "Give them a real expectation rather than 'soon': this store ships orders in " +
        "@shipping.processing_time and delivery then takes @shipping.delivery_time — quote those " +
        "when the order has not shipped yet or the carrier has no events for it. If the store has " +
        "not stated those windows, call knowledge.search for the shipping policy rather than " +
        "repeating a vague phrase back to the customer. If the carrier's transitDays has already " +
        "passed @shipping.delayed_after, this is no longer a status question: do NOT reassure the " +
        "customer the order is on schedule — treat it as a delivery problem and follow that " +
        "playbook instead.",
    },
    {
      key: "delivery_issue",
      label: "Delivery problem (lost / stuck / late)",
      recognition: "A shipped order is lost, stuck in transit, or very late.",
      builtin: true,
      enabled: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "escalate_and_wait",
      notes:
        "Verify the carrier status first with tracking.lookup. There is no fixed number of days " +
        "that counts as too long — this store treats a shipment as delayed once it has been in " +
        "transit for @shipping.delayed_after. transitDays past that is LATE. daysSinceLastScan " +
        "reaching it means the parcel has gone silent for as long as the store's whole delivery " +
        "window — it is STALLED, a real delivery problem even while the status still reads in " +
        "transit. Treat an exception status as a real delivery problem too. Compare the carrier's " +
        "transitDays against the threshold; do not count the days yourself. Never judge lateness " +
        "from the customer's wording, and never invent a window: if the store has not stated a " +
        "threshold, call knowledge.search for the shipping policy's delivery window, and if that " +
        "documents none either — or either carrier number is null — you cannot confirm lateness, " +
        "so say so rather than asserting the order is on schedule. On a real delivery problem, " +
        "escalate to the supplier to reship AND always send the customer a short reassuring reply " +
        "in the same run — we are looking into it and will follow up — without promising a " +
        "specific outcome yet. " +
        "Once the carrier's transitDays reaches @shipping.lost_after with the parcel still " +
        "undelivered, treat it as genuinely lost: stop waiting and make the customer whole — a " +
        "reshipment via the supplier, or a refund if no replacement is possible. If there is no " +
        "supplier, offer a refund, and tell the customer it takes @returns.refund_processing_time " +
        "to appear.",
    },
    {
      key: "damaged_product",
      label: "Damaged or defective item",
      recognition: "The item arrived damaged, defective, or broken.",
      builtin: true,
      enabled: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "escalate_and_wait",
      notes:
        "Damage claims need evidence. If the customer's message has NO photos of the damage, " +
        "use conversation.ask_customer ONCE to ask for clear photos from a couple of angles plus " +
        "the outer packaging, then stop — the ticket waits for their reply. " +
        "If photos ARE attached, look up the order, then call shopify.get_product for the damaged " +
        "line item and compare the customer's photos against the product's reference images. Record " +
        "your verdict with ticket.update_context (productMatch: match / mismatch / uncertain). " +
        "If the photos do NOT match the ordered product (mismatch), or you genuinely can't tell " +
        "(uncertain), do NOT accuse or deny the customer — flag it for the store owner with " +
        "merchant.notify and draft a softer reply that asks them to confirm the order and which item " +
        "is damaged, without committing to a refund amount yet. " +
        "When the damage is verified (productMatch = match), prefer a replacement via the supplier; " +
        "refund only if no replacement is possible. On a multi-item order, refund only the damaged " +
        "line item: use that lineItems entry's unitPrice amount (times the affected quantity when " +
        "more than one unit is clearly damaged) as the partial refund amount for refund.create; " +
        "do not infer a line amount from the order total, and ask/flag a human if the damaged item " +
        "or unitPrice is ambiguous. Then tell the customer the refund takes " +
        "@returns.refund_processing_time to appear. A damaged item is our fault, not the " +
        "customer's: never make them pay to send it back, whatever the store's general " +
        "return-shipping rule says, and do not hold them to @returns.return_window — that window " +
        "is for change-of-mind returns, not for goods that arrived broken. Use knowledge.search " +
        "for anything the facts above don't cover (warranty terms, what to do with the damaged " +
        "item).",
    },
    {
      key: "wrong_item",
      label: "Wrong item received",
      recognition:
        "The customer received a different product than they ordered — the wrong size, colour, or variant, or an entirely different item.",
      builtin: true,
      enabled: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "escalate_and_wait",
      notes:
        "Like a damage claim, the fix depends on seeing what arrived. If the message has NO photo of " +
        "the item received, use conversation.ask_customer ONCE for a clear photo of what they got " +
        "(and the packing slip if handy), then stop. If a photo IS present, look up the order and call " +
        "shopify.get_product for the ordered line item to compare what was sent against what was " +
        "ordered; record your verdict with ticket.update_context (productMatch: match / mismatch / " +
        "uncertain — here a mismatch SUPPORTS the customer, it means the photo really shows a different " +
        "product). If you genuinely can't tell (uncertain), do NOT accuse or deny — flag it for the " +
        "store owner with merchant.notify and draft a softer reply asking them to confirm the order and " +
        "what they received. When it is clearly the wrong item this is OUR error: we cover return " +
        "shipping, and the fix is to send the correct product — escalate to the supplier to ship the " +
        "right item and reassure the customer we are correcting it. Refund only if the correct item " +
        "can't be sent. On a multi-item order, refund only the wrong line item: use that lineItems " +
        "entry's unitPrice amount (times the affected quantity when more than one unit is clearly " +
        "wrong) as the partial refund amount for refund.create; do not infer a line amount from the " +
        "order total, and ask/flag a human if the affected item or unitPrice is ambiguous. Then tell " +
        "the customer the refund takes @returns.refund_processing_time to appear. Check terms " +
        "against the store's policy with knowledge.search before quoting them.",
    },
    {
      key: "refund_request",
      label: "Refund request",
      recognition:
        "Customer explicitly asks for their money back (not a delivery problem).",
      builtin: true,
      enabled: true,
      enabledActions: [
        { tool: "refund.create", permission: "ask" },
        { tool: "discount.create", permission: "ask" },
      ],
      supplierMode: "none",
      notes:
        "Check the order and confirm the request against the store's return policy: returns are " +
        "accepted within @returns.return_window of delivery, so if it is past that window explain " +
        "politely rather than refunding by default. When the item has to come back, be straight " +
        "about who pays — @returns.return_shipping. When a refund is due, tell the customer it is " +
        "issued @returns.refund_method and takes @returns.refund_processing_time to appear; quote " +
        "those rather than guessing, and never promise a payout route this store does not use. " +
        "Prefer a replacement or store credit before a full refund when appropriate. If the order " +
        "has multiple lineItems and the customer's complaint clearly names or matches one line item, " +
        "you may offer a partial refund for that one line item using that line's unitPrice amount " +
        "(times the affected quantity when they clearly identify more than one unit). When you queue " +
        "the refund with refund.create, use that exact partial amount. Do not infer a line-item " +
        "amount from the order total, and do not offer a one line item partial refund when the " +
        "affected item or unitPrice is ambiguous. Use knowledge.search for anything the facts above " +
        "don't cover (return address, non-returnable items, exchanges).",
    },
    {
      key: "order_cancellation",
      label: "Cancel my order",
      recognition:
        "Customer wants to cancel an order they placed (e.g. changed their mind, ordered by mistake), before it ships.",
      builtin: true,
      enabled: true,
      enabledActions: [{ tool: "order.cancel", permission: "ask" }],
      supplierMode: "none",
      notes:
        "Look up the order and check the store's cancellation policy with knowledge.search. " +
        "An order is only cancellable while it is still in the warehouse, which is roughly " +
        "@shipping.processing_time from when it was placed — so act on this quickly. " +
        "If it has NOT shipped yet (fulfillment unfulfilled and not already cancelled), propose " +
        "order.cancel to cancel and refund it, and tell the customer the cancellation is done and " +
        "the refund takes @returns.refund_processing_time to appear. If it has ALREADY shipped " +
        "(fulfilled / in transit / delivered), do NOT cancel — tell the customer it has already " +
        "shipped and can no longer be cancelled, and that if they would like a refund they can " +
        "return the order to us within @returns.return_window of delivery and we will refund it " +
        "per our return policy.",
    },
    {
      key: "shipping_address_update",
      label: "Update my shipping address",
      recognition:
        "Customer wants to change or correct the shipping / delivery address on an order they placed (moved, typo'd the address, wrong apartment).",
      builtin: true,
      enabled: true,
      enabledActions: [
        { tool: "order.update_shipping_address", permission: "ask" },
      ],
      supplierMode: "escalate_and_wait",
      notes:
        "Look up the order first. The address is only editable until the order leaves the " +
        "warehouse, which is about @shipping.processing_time from when it was placed — so treat " +
        "this as urgent and do not sit on it. If it has NOT shipped yet (no fulfillments and not " +
        "cancelled): when the customer already gave the complete new address, update it with " +
        "order.update_shipping_address and confirm the change; when they did not, ask them for the " +
        "full new address (street, city, state/province, postal code, country) with " +
        "conversation.ask_customer and update it once they reply — never guess or fill in missing " +
        "parts yourself. If the order HAS already shipped, the address on the order can no longer " +
        "redirect the parcel — do not edit it; escalate to the supplier with the customer's new " +
        "address and wait for their answer before promising the customer anything.",
    },
    {
      key: "general_inquiry",
      label: "General question",
      recognition: "A general store, product, or policy question.",
      builtin: true,
      enabled: true,
      enabledActions: [],
      supplierMode: "none",
      notes:
        "Answer from the knowledge base and product catalog. The questions customers ask most " +
        "already have stated answers, so quote them instead of searching: orders ship in " +
        "@shipping.processing_time and arrive in @shipping.delivery_time, and returns are accepted " +
        "within @returns.return_window of delivery. Use knowledge.search for anything those don't " +
        "cover (product details, store policies, contact info) and say you'll check rather than " +
        "inventing a number. Decline offers/scams and hand off anything out of scope to a human.",
    },
  ],
};

const isSupplierMode = (v: unknown): v is SupplierMode =>
  v === "escalate_and_wait" || v === "notify_and_proceed" || v === "none";

/** Keep only well-formed `{ tool, permission }` actions; drop the rest. */
const decodeScenarioActions = (raw: unknown): ScenarioAction[] => {
  const actionsRaw = Array.isArray(raw) ? raw : [];
  const enabledActions: ScenarioAction[] = [];
  for (const a of actionsRaw) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const tool = ar["tool"];
    const permission = ar["permission"];
    if (
      typeof tool === "string" &&
      tool.length > 0 &&
      (permission === "allow" || permission === "ask")
    ) {
      enabledActions.push({ tool, permission });
    }
  }
  return enabledActions;
};

/** Decode one scenario; returns null when key/label/supplierMode are invalid. */
const decodeScenario = (raw: unknown): ScenarioPolicy | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = r["key"];
  const label = r["label"];
  const builtin = r["builtin"];
  const supplierMode = r["supplierMode"];
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    typeof label !== "string" ||
    label.length === 0 ||
    typeof builtin !== "boolean" ||
    !isSupplierMode(supplierMode)
  ) {
    return null;
  }
  const enabledActions = decodeScenarioActions(r["enabledActions"]);
  const recognition = r["recognition"];
  const notes = r["notes"];
  // Default-true: only an explicit `false` disables (back-compat — scenarios
  // stored before this field, and the seeded built-ins, are enabled).
  const enabled = r["enabled"] !== false;
  return {
    key,
    label,
    builtin,
    enabled,
    enabledActions,
    supplierMode,
    ...(typeof recognition === "string" && recognition.length > 0
      ? { recognition }
      : {}),
    ...(typeof notes === "string" && notes.length > 0 ? { notes } : {}),
  };
};

/**
 * Decode the persisted JSONB `resolutionPolicy` block. Returns the seeded
 * built-ins when the value is missing, malformed, or contains no valid
 * scenario (defends against hand-edited rows). Individual invalid scenarios /
 * actions are dropped; a wholly-empty result falls back to the defaults.
 */
export const decodeResolutionPolicy = (raw: unknown): ResolutionPolicy => {
  if (!raw || typeof raw !== "object") return defaultResolutionPolicy;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r["scenarios"])) return defaultResolutionPolicy;
  const scenarios = r["scenarios"]
    .map(decodeScenario)
    .filter((s): s is ScenarioPolicy => s !== null);
  return scenarios.length > 0 ? { scenarios } : defaultResolutionPolicy;
};

/**
 * Custom (merchant-authored) scenario keys are namespaced so they can NEVER
 * collide with a built-in key — the write decoder forces this prefix on every
 * custom key, and built-ins are matched/emitted first.
 */
export const CUSTOM_SCENARIO_KEY_PREFIX = "custom_";

/** Lowercase ascii slug ([a-z0-9_]), suitable for a scenario key fragment. */
const slugifyScenarioKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

/** Stable, namespaced key for a custom scenario: keep an already-assigned key,
 *  otherwise derive one from the label. Always carries the custom prefix. */
const customScenarioKey = (rawKey: string, label: string): string => {
  const base = slugifyScenarioKey(rawKey) || slugifyScenarioKey(label) || "scenario";
  return base.startsWith(CUSTOM_SCENARIO_KEY_PREFIX)
    ? base
    : `${CUSTOM_SCENARIO_KEY_PREFIX}${base}`;
};

/** Append `_2`, `_3`, … until the key is free. */
const dedupeScenarioKey = (key: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(key)) return key;
  let n = 2;
  while (taken.has(`${key}_${n}`)) n += 1;
  return `${key}_${n}`;
};

interface EditableScenarioFields {
  readonly key: string; // raw; "" means "assign one"
  readonly label: string; // trimmed; "" means drop (custom) / fall back (built-in)
  readonly recognition?: string;
  readonly enabled: boolean;
  readonly enabledActions: ReadonlyArray<ScenarioAction>;
  readonly supplierMode: SupplierMode;
  readonly notes?: string;
}

/** Lenient row parse for the write path: tolerates an empty key (new custom)
 *  and an invalid supplierMode (defaults to none); never trusts `builtin`. */
const extractScenarioRow = (raw: unknown): EditableScenarioFields | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r["key"] === "string" ? r["key"] : "";
  const label = typeof r["label"] === "string" ? r["label"].trim() : "";
  const recognition =
    typeof r["recognition"] === "string" ? r["recognition"].trim() : "";
  const notes = typeof r["notes"] === "string" ? r["notes"].trim() : "";
  return {
    key,
    label,
    enabled: r["enabled"] !== false,
    enabledActions: decodeScenarioActions(r["enabledActions"]),
    supplierMode: isSupplierMode(r["supplierMode"]) ? r["supplierMode"] : "none",
    ...(recognition ? { recognition } : {}),
    ...(notes ? { notes } : {}),
  };
};

/**
 * Decode a merchant-submitted resolution policy (the dashboard SAVE path).
 * Unlike `decodeResolutionPolicy` (the trusting read decoder), this is the
 * server-side authority on the shape merchants are allowed to persist:
 *   - Built-ins are ALWAYS present (a merchant can't delete one) and their
 *     immutable fields (key/label/recognition/builtin) are forced from the
 *     seeded defaults; only the editable fields (enabled / enabledActions /
 *     supplierMode / notes) are taken from the body.
 *   - Custom scenarios are accepted with `builtin` forced to false, a label
 *     (required — blank ones are dropped), and a stable, unique, namespaced
 *     key: an already-assigned `custom_*` key is kept as-is (so renaming the
 *     label never re-keys an in-flight scenario), otherwise one is derived
 *     from the label. Keys are deduped and can never collide with a built-in.
 * Built-ins are emitted first, in their seeded order, then customs in body
 * order. A wholly malformed body yields the default built-ins.
 */
export const decodeResolutionPolicyUpdate = (raw: unknown): ResolutionPolicy => {
  const rows: EditableScenarioFields[] = [];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["scenarios"])) {
    for (const r of (raw as Record<string, unknown>)["scenarios"] as unknown[]) {
      const row = extractScenarioRow(r);
      if (row) rows.push(row);
    }
  }

  const defaultByKey = new Map(
    defaultResolutionPolicy.scenarios.map((s) => [s.key, s] as const),
  );
  const sentBuiltins = new Map<string, EditableScenarioFields>();
  const customRows: EditableScenarioFields[] = [];
  for (const row of rows) {
    if (row.key && defaultByKey.has(row.key)) sentBuiltins.set(row.key, row);
    else customRows.push(row);
  }

  const taken = new Set<string>();
  const out: ScenarioPolicy[] = [];

  // Built-ins: always present; immutable fields from defaults, editable from body.
  for (const def of defaultResolutionPolicy.scenarios) {
    taken.add(def.key);
    const sent = sentBuiltins.get(def.key);
    const notes = sent ? sent.notes : def.notes;
    out.push({
      key: def.key,
      label: def.label,
      builtin: true,
      enabled: sent ? sent.enabled : def.enabled !== false,
      enabledActions: sent ? sent.enabledActions : def.enabledActions,
      supplierMode: sent ? sent.supplierMode : def.supplierMode,
      ...(def.recognition ? { recognition: def.recognition } : {}),
      ...(notes ? { notes } : {}),
    });
  }

  // Customs: builtin forced false; stable unique namespaced key; label required.
  for (const row of customRows) {
    if (!row.label) continue;
    const key = dedupeScenarioKey(customScenarioKey(row.key, row.label), taken);
    taken.add(key);
    out.push({
      key,
      label: row.label,
      builtin: false,
      enabled: row.enabled,
      enabledActions: row.enabledActions,
      supplierMode: row.supplierMode,
      ...(row.recognition ? { recognition: row.recognition } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
    });
  }

  return { scenarios: out };
};

/**
 * Deprecated tenant-settings default retained so older tenant JSON and test
 * fixtures still decode. It no longer drives ticket retention; the worker's
 * current fixed policy lives in `apps/worker/src/retention-sweep.ts`.
 */
export const DEFAULT_RETENTION_DAYS = 365;

/**
 * Per-tenant target for warehouse / supplier escalation rows written
 * by the `supplier.add_sheet_row` tool. When unset (`null`), agents
 * that would otherwise escalate skip the sheet write and go straight
 * to their customer reply — the prompt is written to be robust to
 * missing config.
 *
 * `range` is an A1 reference that includes the sheet name (e.g.
 * `Escalations!A:F`). 17track's append semantics inside Google Sheets
 * append below the last non-empty row inside the column span.
 *
 * `description` is operator-visible context surfaced on the dashboard
 * settings page; it never reaches the agent prompt or the sheet itself.
 */
export interface SupplierEscalationSheet {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly description: string | null;
}

export const defaultSupplierEscalationSheet: SupplierEscalationSheet | null =
  null;

/**
 * Versions accepted by merchants before production connector credentials are
 * written. Bump these when the merchant-facing notice or DPA materially
 * changes; tenants with older versions must re-accept before new connector
 * writes are allowed.
 */
export const DATA_PROCESSING_NOTICE_VERSION = "2026-07-07";
export const DPA_VERSION = "2026-06-04";

export interface LegalAcceptance {
  readonly dataProcessingNoticeVersion: string;
  readonly dpaVersion: string;
  readonly acceptedAt: string;
  readonly acceptedByUserId: string | null;
}

export const legalAcceptanceIsCurrent = (
  acceptance: LegalAcceptance | null,
): boolean =>
  acceptance?.dataProcessingNoticeVersion === DATA_PROCESSING_NOTICE_VERSION &&
  acceptance.dpaVersion === DPA_VERSION &&
  acceptance.acceptedAt.length > 0;

export class TenantSettings extends Data.Class<{
  /** Email the platform sends approval / system mail to. */
  readonly notificationEmail: string | null;
  /**
   * Conditional thresholds for `refund.create`. Configurable per-tenant
   * via the dashboard `/settings/refund-policy` page. Always populated —
   * we fall back to `defaultRefundPolicy` when the JSONB column has no
   * matching block (or has malformed values).
   */
  readonly refundPolicy: RefundPolicy;
  /**
   * Conditional thresholds for `discount.create` (goodwill coupon codes).
   * Configurable per-tenant via the dashboard `/settings/discount-policy`
   * page. Always populated — we fall back to `defaultDiscountPolicy` when
   * the JSONB column has no matching block (or has malformed values).
   */
  readonly discountPolicy: DiscountPolicy;
  /**
   * Legacy compatibility setting retained for older stored tenant JSON and
   * test fixtures. The current worker policy is fixed: archive resolved tickets
   * after 30 days, then delete archived tickets after 12 calendar months.
   */
  readonly retentionDays: number;
  /**
   * Optional Google Sheet target for `supplier.add_sheet_row`. When
   * null the agent runtime omits the supplier-escalation header from
   * the system prompt and the missing-package-agent's BRANCH A skips
   * its sheet-write step entirely.
   */
  readonly supplierEscalationSheet: SupplierEscalationSheet | null;
  /**
   * Merchant acceptance of the current data processing notice + DPA.
   * Null means connector credential writes must be blocked.
   */
  readonly legalAcceptance: LegalAcceptance | null;
  /**
   * Model id used by the dashboard "Rephrase with AI" action. Optional /
   * nullable — when unset the rephrase handler falls back to a built-in
   * default. Picked from the tenant's provider catalog via the composer's
   * model dropdown. Stored as a sibling key in the same `tenants.settings`
   * JSONB; reads tolerate its absence (older rows have no value).
   */
  readonly rephraseModel?: string | null;
  /**
   * Whether the `order.cancel` tool returns the cancelled order's items to
   * inventory (Shopify's `restock` flag). Merchant-configurable via the
   * dashboard refund-policy page's "Order cancellations" section. Optional
   * on the class (older construction sites don't ripple); the Live
   * `getSettings` always populates it, defaulting to `true` when the JSONB
   * column has no value (absent ⇒ restock, the safe default for stores that
   * track stock). Readers building settings by hand should default to true.
   */
  readonly cancellationRestock?: boolean;
  /**
   * Merchant-configurable per-scenario playbooks for the scenario-resolution
   * agent. Optional on the class (so existing construction sites don't ripple);
   * the Live `getSettings` ALWAYS populates it via `decodeResolutionPolicy`
   * (defaults-on-read → the seeded built-ins), so readers can rely on it being
   * present from the repository. Readers that build settings by hand should
   * fall back to `defaultResolutionPolicy`.
   */
  readonly resolutionPolicy?: ResolutionPolicy;
  /**
   * Sender blocklist: inbound mail whose From or Reply-To matches an
   * entry is dropped before any ticket work (no ticket, no agent tick).
   * Optional on the class (existing construction sites don't ripple);
   * the Live `getSettings` always populates it via `decodeBlockedSenders`
   * (defaults-on-read → empty lists). Readers building settings by hand
   * should fall back to `defaultBlockedSenders`.
   */
  readonly blockedSenders?: BlockedSenders;
  /**
   * The store's structured shipping facts — processing/delivery times, cost,
   * customs, and the day count past which a shipment counts as delayed. Edited
   * on the dashboard Knowledge base page. Optional on the class (existing
   * construction sites don't ripple); the Live `getSettings` always populates it
   * via `decodeShippingFacts`, which yields `null` for an unconfigured or
   * half-written block. `null` means the agents fall back to searching the
   * merchant's knowledge documents for a delivery window, as they did before
   * this existed.
   */
  readonly shippingFacts?: ShippingFacts | null;
  /**
   * The store's structured returns/refund facts — return window, who pays
   * return shipping, refund method, and the processing time to quote. Edited on
   * the dashboard Knowledge base page. Optional on the class (existing
   * construction sites don't ripple); the Live `getSettings` always populates it
   * via `decodeReturnsFacts`, which yields `null` for an unconfigured or
   * half-written block (only `returnWindowDays` is all-or-nothing). `null` means
   * the agents fall back to searching the merchant's knowledge documents for the
   * return policy, as they did before this existed.
   */
  readonly returnsFacts?: ReturnsFacts | null;
}> {}

export class TenantNotFound extends Data.TaggedError("TenantNotFound")<{
  readonly tenantId: TenantId;
}> {}

export class TenantRepositoryDbError extends Data.TaggedError(
  "TenantRepositoryDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type TenantRepositoryError = TenantNotFound | TenantRepositoryDbError;

export class TenantRepository extends Context.Tag("TenantRepository")<
  TenantRepository,
  {
    readonly getSettings: (
      tenantId: TenantId,
    ) => Effect.Effect<TenantSettings, TenantRepositoryError>;
    /**
     * Replace the tenant's refund policy. Writes the new block into the
     * `tenants.settings` JSONB column without touching unrelated fields
     * (deep-merge semantics enforced by the Live impl).
     */
    readonly setRefundPolicy: (
      tenantId: TenantId,
      policy: RefundPolicy,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Replace the tenant's discount (coupon) policy. Same deep-merge
     * semantics as `setRefundPolicy` — unrelated settings columns are
     * preserved.
     */
    readonly setDiscountPolicy: (
      tenantId: TenantId,
      policy: DiscountPolicy,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Set (or clear) the tenant's supplier-escalation sheet target.
     * Passing `null` clears the field so the agent's BRANCH A skips
     * its sheet-write step. Same deep-merge semantics as
     * `setRefundPolicy` — unrelated settings columns are preserved.
     */
    readonly setSupplierEscalationSheet: (
      tenantId: TenantId,
      sheet: SupplierEscalationSheet | null,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Record that the tenant accepted the current data processing notice and
     * DPA. This is a legal/compliance gate for production connector writes.
     */
    readonly setLegalAcceptance: (
      tenantId: TenantId,
      acceptance: LegalAcceptance,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Set (or clear, with `null`) the model used by the "Rephrase with AI"
     * action. Same deep-merge semantics as `setRefundPolicy` — unrelated
     * settings columns are preserved.
     */
    readonly setRephraseModel: (
      tenantId: TenantId,
      model: string | null,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Set whether `order.cancel` restocks the cancelled order's items. Same
     * deep-merge semantics as `setRefundPolicy` — unrelated settings columns
     * are preserved.
     */
    readonly setCancellationRestock: (
      tenantId: TenantId,
      restock: boolean,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Replace the tenant's resolution policy (per-scenario playbooks). Same
     * deep-merge semantics as `setRefundPolicy` — unrelated settings columns
     * are preserved.
     */
    readonly setResolutionPolicy: (
      tenantId: TenantId,
      policy: ResolutionPolicy,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Replace the tenant's sender blocklist (both lists at once). Values
     * must already be normalized (`normalizeBlockedSenderInput`). Same
     * deep-merge semantics as `setRefundPolicy` — unrelated settings
     * columns are preserved.
     */
    readonly setBlockedSenders: (
      tenantId: TenantId,
      blocked: BlockedSenders,
    ) => Effect.Effect<void, TenantRepositoryError>;

    /**
     * Replace the tenant's shipping facts. `null` clears it, sending agents
     * back to `knowledge.search` for the delivery window. Same shallow JSONB
     * merge as `setRefundPolicy` — unrelated settings are preserved.
     */
    readonly setShippingFacts: (
      tenantId: TenantId,
      profile: ShippingFacts | null,
    ) => Effect.Effect<void, TenantRepositoryError>;

    /**
     * Replace the tenant's returns facts. `null` clears it, sending agents back
     * to `knowledge.search` for the return policy. Same shallow JSONB merge as
     * `setRefundPolicy` — unrelated settings are preserved.
     */
    readonly setReturnsFacts: (
      tenantId: TenantId,
      facts: ReturnsFacts | null,
    ) => Effect.Effect<void, TenantRepositoryError>;
  }
>() {}

// ============================================================
// Test layer
// ============================================================

export interface TenantRepositoryTestFixtures {
  readonly settingsByTenant?: ReadonlyMap<TenantId, TenantSettings>;
}

export const TenantRepositoryTest = (
  fixtures: TenantRepositoryTestFixtures = {},
): Layer.Layer<TenantRepository> => {
  // Mutable copy so setRefundPolicy is observable in tests.
  const store = new Map<TenantId, TenantSettings>(
    fixtures.settingsByTenant
      ? Array.from(fixtures.settingsByTenant.entries())
      : [],
  );
  return Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: (tenantId) => {
        const hit = store.get(tenantId);
        return hit
          ? Effect.succeed(hit)
          : Effect.fail(new TenantNotFound({ tenantId }));
      },
      setRefundPolicy: (tenantId, policy) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(tenantId, new TenantSettings({ ...prev, refundPolicy: policy }));
        return Effect.void;
      },
      setDiscountPolicy: (tenantId, policy) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, discountPolicy: policy }),
        );
        return Effect.void;
      },
      setSupplierEscalationSheet: (tenantId, sheet) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, supplierEscalationSheet: sheet }),
        );
        return Effect.void;
      },
      setLegalAcceptance: (tenantId, acceptance) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, legalAcceptance: acceptance }),
        );
        return Effect.void;
      },
      setRephraseModel: (tenantId, model) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, rephraseModel: model }),
        );
        return Effect.void;
      },
      setCancellationRestock: (tenantId, restock) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, cancellationRestock: restock }),
        );
        return Effect.void;
      },
      setResolutionPolicy: (tenantId, policy) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, resolutionPolicy: policy }),
        );
        return Effect.void;
      },
      setBlockedSenders: (tenantId, blocked) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, blockedSenders: blocked }),
        );
        return Effect.void;
      },
      setShippingFacts: (tenantId, profile) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, shippingFacts: profile }),
        );
        return Effect.void;
      },
      setReturnsFacts: (tenantId, facts) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, returnsFacts: facts }),
        );
        return Effect.void;
      },
    }),
  );
};
