import { Context, Data, Effect, Layer } from "effect";
import type { TenantId } from "@support-agent/agent-core";

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
 *   - `thresholds`  — the amount-based zones above (the normal case)
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
 * `discount.create` tool forces single-use, locks the code to the case
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
 *   - `thresholds`  — the zones above (normal case)
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
      enabledActions: [],
      supplierMode: "none",
      notes:
        "Look up the order, check tracking if available, and tell the customer the status.",
    },
    {
      key: "delivery_issue",
      label: "Delivery problem (lost / stuck / late)",
      recognition: "A shipped order is lost, stuck in transit, or very late.",
      builtin: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "escalate_and_wait",
      notes:
        "Verify the carrier status first. On an exception, escalate to the supplier to reship and let the customer know. If genuinely lost and there is no supplier, offer a refund.",
    },
    {
      key: "damaged_product",
      label: "Damaged or defective item",
      recognition: "The item arrived damaged, defective, or broken.",
      builtin: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "escalate_and_wait",
      notes:
        "Confirm the damage from the customer's description/photos. Prefer a replacement via the supplier; refund if no replacement is possible.",
    },
    {
      key: "refund_request",
      label: "Refund request",
      recognition:
        "Customer explicitly asks for their money back (not a delivery problem).",
      builtin: true,
      enabledActions: [
        { tool: "refund.create", permission: "ask" },
        { tool: "discount.create", permission: "ask" },
      ],
      supplierMode: "none",
      notes:
        "Check the order and the refund policy. Prefer a replacement or store credit before a full refund when appropriate.",
    },
    {
      key: "general_inquiry",
      label: "General question",
      recognition: "A general store, product, or policy question.",
      builtin: true,
      enabledActions: [],
      supplierMode: "none",
      notes:
        "Answer from the knowledge base and product catalog. Decline offers/scams and hand off anything out of scope to a human.",
    },
  ],
};

const isSupplierMode = (v: unknown): v is SupplierMode =>
  v === "escalate_and_wait" || v === "notify_and_proceed" || v === "none";

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
  const actionsRaw = Array.isArray(r["enabledActions"]) ? r["enabledActions"] : [];
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
  const recognition = r["recognition"];
  const notes = r["notes"];
  return {
    key,
    label,
    builtin,
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
 * Default retention for resolved cases. 24 months from `resolved_at`
 * matches the privacy-policy default in `docs/shopify-pcd.md` §7. The
 * retention sweep cron deletes resolved cases (and their cascaded
 * `case_state_transitions` / `audit_log` rows) past this window.
 *
 * Merchants can shorten this per-tenant via the dashboard; we don't let
 * them lengthen it past the platform-wide regulatory ceiling (today the
 * dashboard form caps at this default).
 */
export const DEFAULT_RETENTION_DAYS = 730;

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
export const DATA_PROCESSING_NOTICE_VERSION = "2026-06-04";
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
   * Days of retention for resolved cases (counted from `resolved_at`).
   * The retention sweep cron deletes anything older. Defaults to
   * `DEFAULT_RETENTION_DAYS` when the tenant has no value set.
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
   * Merchant-configurable per-scenario playbooks for the scenario-resolution
   * agent. Optional on the class (so existing construction sites don't ripple);
   * the Live `getSettings` ALWAYS populates it via `decodeResolutionPolicy`
   * (defaults-on-read → the seeded built-ins), so readers can rely on it being
   * present from the repository. Readers that build settings by hand should
   * fall back to `defaultResolutionPolicy`.
   */
  readonly resolutionPolicy?: ResolutionPolicy;
  /**
   * Per-tenant A/B flag: when true, triage routes cases to the new
   * scenario-resolution agent instead of the legacy specialists. Optional;
   * absent ⇒ false (legacy routing). Lets a merchant test the new agent then
   * adopt or drop it.
   */
  readonly resolutionAgentEnabled?: boolean;
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
     * Replace the tenant's resolution policy (per-scenario playbooks). Same
     * deep-merge semantics as `setRefundPolicy` — unrelated settings columns
     * are preserved.
     */
    readonly setResolutionPolicy: (
      tenantId: TenantId,
      policy: ResolutionPolicy,
    ) => Effect.Effect<void, TenantRepositoryError>;
    /**
     * Toggle the per-tenant scenario-agent A/B flag. Same deep-merge semantics
     * as `setRefundPolicy`.
     */
    readonly setResolutionAgentEnabled: (
      tenantId: TenantId,
      enabled: boolean,
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
      setResolutionAgentEnabled: (tenantId, enabled) => {
        const prev = store.get(tenantId);
        if (!prev) {
          return Effect.fail(new TenantNotFound({ tenantId }));
        }
        store.set(
          tenantId,
          new TenantSettings({ ...prev, resolutionAgentEnabled: enabled }),
        );
        return Effect.void;
      },
    }),
  );
};
