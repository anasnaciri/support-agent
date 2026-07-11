/**
 * `@`-reference catalog + resolver — the merchant-facing mechanism that lets a
 * scenario note reference a store Fact by name (`@returns.return_window`,
 * `@shipping.delivery_time`) so the load-bearing value lives in exactly ONE
 * home and the prose stays in sync with it by construction. Tenant knowledge
 * docs also flow through this resolver as `@docs.<document-id>` refs, but they
 * are never inlined: they expand to an instruction to call `knowledge.search`
 * for the named document.
 *
 * The catalog is code-defined and single-source (same spirit as
 * `TOOL_DISPLAY_NAMES`): each referenceable field carries an id, a dropdown
 * label for the `@` menu, an **inline-render** fn (distinct from the header-line
 * render — a mid-sentence fragment like "30 days", not a bracketed header), and
 * a neutral **fallback phrase** for the null case. The `@` menu (frontend) is
 * generated from this catalog.
 *
 * Grammar: resolve `@ns` (whole-block summary) and `@ns.field` ONLY when the id
 * is in the catalog. Every other `@…` — email addresses, unrelated mentions — is
 * left verbatim. A token under a KNOWN namespace whose id is NOT in the catalog
 * is a mistake (a typo'd ref), so it is left verbatim AND flagged dangling for a
 * non-blocking Scenarios-page warning. A known-id ref whose field is unset
 * resolves to its fallback phrase AND is flagged dangling (the unidirectional
 * dangling condition: "a scenario ref resolves to null").
 *
 * The token is STORED; it is resolved on every render (`buildSystemPrompt` and
 * the dashboard preview) — never resolved-and-stored, so editing a Fact updates
 * every note that references it. This is why `ScenarioPolicy.notes` are no
 * longer "injected verbatim".
 */

import type { TenantSettings } from "./tenant-repository.js";
import type { ReturnShippingPayer, RefundMethod } from "./returns-facts.js";
import type { CustomsDutiesPayer } from "./shipping-facts.js";

/** One referenceable store Fact. `field: null` is the whole-block summary. */
export interface FactReference {
  /** `{namespace}.{field}`, or the bare `{namespace}` for a whole-block ref. */
  readonly id: string;
  readonly namespace: string;
  readonly field: string | null;
  /** Human label shown in the `@` menu. */
  readonly label: string;
  /**
   * Inline fragment for mid-sentence substitution, or `null` when the backing
   * Fact is unset. Distinct from the bracketed header-line render.
   */
  readonly render: (settings: TenantSettings | null) => string | null;
  /**
   * Neutral phrase substituted when {@link render} returns null.
   *
   * Must fit the SAME sentence frame as {@link render} — same grammatical shape
   * — so one frame reads correctly whether or not the Fact is set. A noun-phrase
   * render takes a noun-phrase fallback ("30 days" / "our standard return
   * window"); a clause render takes a clause ("the customer pays return
   * shipping" / "who pays return shipping depends on our returns policy").
   * Mixing the shapes yields broken prose for exactly the tenants who configured
   * nothing — the ones the fallback exists for.
   */
  readonly fallback: string;
}

export interface KnowledgeDocReference {
  readonly id: string;
  readonly title: string;
}

export const KNOWLEDGE_DOC_REFERENCE_NAMESPACE = "docs";

export const knowledgeDocReferenceId = (doc: KnowledgeDocReference): string =>
  `${KNOWLEDGE_DOC_REFERENCE_NAMESPACE}.${doc.id}`;

const quoted = (value: string): string => JSON.stringify(value);

export const renderKnowledgeDocReference = (
  doc: KnowledgeDocReference,
): string =>
  `the knowledge-base document titled ${quoted(doc.title)} (call knowledge.search with query ${quoted(doc.title)} before using it)`;

// ---- inline fragments (distinct from the header-line sentences) ----

const RETURN_SHIPPING_FRAGMENT: Record<ReturnShippingPayer, string> = {
  customer: "the customer pays return shipping",
  merchant: "we cover return shipping",
  depends: "who pays return shipping depends on the situation",
};

const REFUND_METHOD_FRAGMENT: Record<RefundMethod, string> = {
  original: "to the original payment method",
  store_credit: "as store credit",
  customer_choice: "to the original payment method or as store credit",
};

const CUSTOMS_FRAGMENT: Record<CustomsDutiesPayer, string> = {
  customer: "the customer pays any customs or import duties",
  merchant: "we cover any customs or import duties",
  not_applicable: "customs and import duties do not apply",
};

/** Format minor units in a currency, deriving the fraction digits from it. */
const money = (minorUnits: number, currency: string): string => {
  try {
    const fmt = new Intl.NumberFormat("en", { style: "currency", currency });
    const fraction = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minorUnits / 10 ** fraction);
  } catch {
    return `${minorUnits} ${currency} (minor units)`;
  }
};

const refundThresholdFragment = (settings: TenantSettings | null): string => {
  const policy = settings?.refundPolicy ?? null;
  if (!policy) return "your refund approval settings";
  const mode = policy.mode ?? "thresholds";
  if (mode === "always_ask") {
    return "every refund needs your approval before it goes out";
  }
  if (mode === "always_deny") {
    return "the agent cannot issue refunds — every refund is escalated to you";
  }
  const ask = money(policy.askAboveMinorUnits, policy.currencyCode);
  const deny = money(policy.denyAboveMinorUnits, policy.currencyCode);
  return `refunds up to ${ask} are pre-approved, refunds above that need your approval, and refunds over ${deny} are declined`;
};

// ---- catalog ----

const r = (settings: TenantSettings | null) => settings?.returnsFacts ?? null;
const s = (settings: TenantSettings | null) => settings?.shippingFacts ?? null;

/**
 * Field-level entries. Whole-block `@namespace` summaries are derived from these
 * (see {@link namespaceSummary}) so a namespace's fields have a single source.
 */
const FIELD_CATALOG: ReadonlyArray<FactReference> = [
  // returns.*
  {
    id: "returns.return_window",
    namespace: "returns",
    field: "return_window",
    label: "Return window",
    render: (x) => {
      const f = r(x);
      return f ? `${f.returnWindowDays} days` : null;
    },
    fallback: "our standard return window",
  },
  {
    id: "returns.return_shipping",
    namespace: "returns",
    field: "return_shipping",
    label: "Who pays return shipping",
    render: (x) => {
      const f = r(x);
      return f?.returnShippingPayer
        ? RETURN_SHIPPING_FRAGMENT[f.returnShippingPayer]
        : null;
    },
    // Clause, to match the clause-shaped fragments above.
    fallback: "who pays return shipping depends on our returns policy",
  },
  {
    id: "returns.refund_method",
    namespace: "returns",
    field: "refund_method",
    label: "Refund method",
    render: (x) => {
      const f = r(x);
      return f?.refundMethod ? REFUND_METHOD_FRAGMENT[f.refundMethod] : null;
    },
    // Prepositional phrase, to match "to the original payment method" — the
    // frame is "the refund is issued @returns.refund_method".
    fallback: "using our usual refund method",
  },
  {
    id: "returns.refund_processing_time",
    namespace: "returns",
    field: "refund_processing_time",
    label: "Refund processing time",
    render: (x) => r(x)?.refundProcessingTime ?? null,
    fallback: "our usual refund processing time",
  },
  // shipping.*
  {
    id: "shipping.processing_time",
    namespace: "shipping",
    field: "processing_time",
    label: "Order processing time",
    render: (x) => s(x)?.processingTime ?? null,
    fallback: "our usual processing time",
  },
  {
    id: "shipping.delivery_time",
    namespace: "shipping",
    field: "delivery_time",
    label: "Delivery time",
    render: (x) => s(x)?.deliveryTime ?? null,
    fallback: "our usual delivery time",
  },
  {
    id: "shipping.shipping_cost",
    namespace: "shipping",
    field: "shipping_cost",
    label: "Shipping cost",
    render: (x) => s(x)?.shippingCost ?? null,
    fallback: "our standard shipping rates",
  },
  {
    id: "shipping.customs",
    namespace: "shipping",
    field: "customs",
    label: "Customs / duties",
    render: (x) => {
      const p = s(x)?.customsDuties;
      return p ? CUSTOMS_FRAGMENT[p] : null;
    },
    fallback: "our customs and duties policy",
  },
  {
    id: "shipping.delayed_after",
    namespace: "shipping",
    field: "delayed_after",
    label: "Delayed-after threshold",
    render: (x) => {
      const p = s(x);
      return p ? `${p.delayedAfterDays} days` : null;
    },
    fallback: "our usual delivery window",
  },
  {
    id: "shipping.lost_after",
    namespace: "shipping",
    field: "lost_after",
    label: "Treat-as-lost threshold",
    render: (x) => {
      const days = s(x)?.lostPackageInvestigationDays;
      return days != null ? `${days} days` : null;
    },
    fallback: "our usual lost-package window",
  },
  // refunds.* — read-only, auto-synced from the enforcement policy (never
  // editable through a note; framed as "what your settings currently say").
  {
    id: "refunds.approval_threshold",
    namespace: "refunds",
    field: "approval_threshold",
    label: "Refund approval threshold (read-only)",
    render: (x) => refundThresholdFragment(x),
    fallback: "your refund approval settings",
  },
];

/**
 * Whole-block summary for a namespace: the non-null field fragments joined into
 * one clause, or the namespace's own fallback when nothing is configured.
 */
const namespaceSummary = (
  namespace: string,
  fields: ReadonlyArray<FactReference>,
  fallback: string,
) => ({
  id: namespace,
  namespace,
  field: null,
  label: `All ${namespace} facts`,
  render: (settings: TenantSettings | null): string | null => {
    const parts = fields
      .map((f) => f.render(settings))
      .filter((v): v is string => !!v && v.trim().length > 0);
    return parts.length > 0 ? parts.join("; ") : null;
  },
  fallback,
});

const SUMMARY_CATALOG: ReadonlyArray<FactReference> = [
  namespaceSummary(
    "returns",
    FIELD_CATALOG.filter((f) => f.namespace === "returns"),
    "our returns and refunds policy",
  ),
  namespaceSummary(
    "shipping",
    FIELD_CATALOG.filter((f) => f.namespace === "shipping"),
    "our shipping and delivery policy",
  ),
];

/** The single source of truth for every `@`-referenceable Fact. */
export const FACT_REFERENCE_CATALOG: ReadonlyArray<FactReference> = [
  ...FIELD_CATALOG,
  ...SUMMARY_CATALOG,
];

/** id → entry, for O(1) resolution and dashboard menu grouping. */
export const factReferenceById: ReadonlyMap<string, FactReference> = new Map(
  FACT_REFERENCE_CATALOG.map((e) => [e.id, e]),
);

/** The namespaces the resolver owns — used to tell a typo'd ref from an email. */
export const FACT_NAMESPACES: ReadonlySet<string> = new Set(
  FACT_REFERENCE_CATALOG.map((e) => e.namespace),
);

// `@ns` or `@ns.field`. Fact fields are lowercase identifiers; doc refs use
// `@docs.<uuid>`, so the field side also accepts digits and hyphens. The
// optional field group is only taken when a `.` is immediately followed by a
// token char — so `@returns.` (trailing punct) still resolves the bare
// `@returns` summary.
const TOKEN = /@([a-z][a-z0-9_]*)(?:\.([a-z0-9][a-z0-9_-]*))?/gi;

export interface ResolvedReferences {
  readonly resolved: string;
  /** Catalog ids (or known-namespace typos) that did not resolve to a value. */
  readonly dangling: ReadonlyArray<string>;
}

/**
 * Resolve every catalog `@`-reference in `text` against the tenant's Facts,
 * returning the rewritten text and the list of dangling references (for the
 * non-blocking Scenarios-page warning). Pure — the caller decides where to
 * render it (the system prompt, the dashboard preview).
 */
export const resolveFactReferences = (
  text: string,
  settings: TenantSettings | null,
  knowledgeDocs: ReadonlyArray<KnowledgeDocReference> = [],
): ResolvedReferences => {
  const dangling: string[] = [];
  const docByRef = new Map(
    knowledgeDocs.map((doc) => [knowledgeDocReferenceId(doc).toLowerCase(), doc]),
  );
  const resolved = text.replace(TOKEN, (match, ns: string, field?: string) => {
    const namespace = ns.toLowerCase();
    const id = field ? `${namespace}.${field.toLowerCase()}` : namespace;
    const doc = docByRef.get(id);
    if (doc) return renderKnowledgeDocReference(doc);
    const entry = factReferenceById.get(id);
    if (entry) {
      const rendered = entry.render(settings);
      if (rendered && rendered.trim().length > 0) return rendered;
      dangling.push(id);
      return entry.fallback;
    }
    // Not a catalog id. A KNOWN namespace means a mistaken ref (typo, removed
    // field) — flag it dangling but leave the raw token so the merchant can see
    // and fix it. An unknown namespace is an email / unrelated mention — leave
    // it verbatim and never flag it.
    if (
      FACT_NAMESPACES.has(namespace) ||
      namespace === KNOWLEDGE_DOC_REFERENCE_NAMESPACE
    ) {
      dangling.push(id);
    }
    return match;
  });
  return { resolved, dangling };
};
