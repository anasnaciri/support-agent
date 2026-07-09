/**
 * Turns a ticket's freeform `context` blob into an ordered list of operator-
 * friendly rows for the Context panel — labeled fields and chips instead of a
 * raw JSON dump. The known keys mirror `ticket.update_context`'s closed schema
 * (packages/tools) plus the runtime-reserved keys (`customerEmail`,
 * `riskFlags`, `photoSignals`); anything else is humanized as a fallback row so
 * a newly-added backend field is still visible while it waits for a real label.
 */
import type { BadgeProps } from "@/components/ui/badge";
import { humanizeSlug } from "./labels";
import {
  parseRequestedResolution,
  parseReturnReason,
  requestedResolutionLabel,
  returnReasonLabel,
} from "./return-labels";
import { buildRiskFlagBadges } from "./risk-flag-label";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export interface ContextBadge {
  readonly text: string;
  readonly variant: BadgeVariant;
  /** Tickets this chip references (duplicate-photo guard) — the renderer links
   *  them: inline for one, in a hover tooltip for many. */
  readonly ticketIds?: ReadonlyArray<string>;
}

export interface ContextRow {
  readonly key: string;
  readonly label: string;
  /** When present, render the value as one or more chips instead of text. */
  readonly badges?: ReadonlyArray<ContextBadge>;
  /** Plain-text value (already humanized). */
  readonly text?: string;
  /** Render `text` in a monospace font (ids, emails). */
  readonly mono?: boolean;
  /** Render `text` as a wrapped, newline-preserving paragraph (notes). */
  readonly multiline?: boolean;
  /** Render a skeleton placeholder — the row's value hasn't resolved yet. */
  readonly skeleton?: boolean;
}

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Humanize an unknown context KEY for a fallback row. Unlike the shared
 * `humanizeSlug` (built for snake_case slugs), context keys are camelCase
 * (`someFutureField`), so split on ticket boundaries too → "Some future field".
 */
const humanizeKey = (key: string): string => {
  const words = key
    .replace(/[._]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const recordOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const PRODUCT_MATCH: Readonly<Record<string, ContextBadge>> = {
  match: { text: "Photos match the item", variant: "success" },
  mismatch: { text: "Photos don’t match", variant: "destructive" },
  uncertain: { text: "Can’t tell from photos", variant: "warning" },
};

const formatPhotoSignals = (v: unknown): string | null => {
  const r = recordOf(v);
  if (!r || typeof r["count"] !== "number") return null;
  const count = r["count"];
  const parts = [`${count} photo${count === 1 ? "" : "s"}`];
  if (typeof r["withExif"] === "number" && r["withExif"] > 0)
    parts.push(`${r["withExif"]} with location data`);
  if (typeof r["stripped"] === "number" && r["stripped"] > 0)
    parts.push(`${r["stripped"]} had metadata removed`);
  return parts.join(" · ");
};

/** Last-resort stringifier for keys we don't have a bespoke row for. */
const formatUnknown = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    return s && s !== "{}" && s !== "[]" ? s : null;
  } catch {
    return null;
  }
};

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "classification",
  "customerEmail",
  "verifiedCustomerEmail",
  "identifiedOrderId",
  "quotedOrderRef",
  "identifiedCustomerId",
  "returnReason",
  "requestedResolution",
  "productMatch",
  "photoSignals",
  "riskFlags",
  "liveTrackingStatus",
  "notes",
  "supplierUpdate",
]);

/** The keys the floating context card shows — the customer's ask, evidence
 *  signals, risk flags, notes, and the supplier's answer to an escalation.
 *  Everything else in the context is either
 *  already rendered by the Customer/Order/Tracking panels and the ticket header
 *  (email, order, category, tracking) or internal runtime machinery
 *  (`identityVerified`, `scenarioKey`, lookup markers). */
const CARD_KEYS: ReadonlySet<string> = new Set([
  "returnReason",
  "requestedResolution",
  "productMatch",
  "photoSignals",
  "riskFlags",
  "notes",
  "supplierNote",
  "supplierProposedResolution",
  "supplierAttachments",
]);

/** Normalize an order ref for equality: trim, strip a leading #, lowercase. */
const normalizeOrderRef = (ref: string): string =>
  ref.trim().replace(/^#/, "").toLowerCase();

/** The slice of the resolved Shopify order the card comparison needs. */
export interface ContextCardOrder {
  readonly name: string | null;
  readonly confirmationNumber: string | null;
}

/**
 * The floating context card's rows: {@link buildContextRows} filtered to
 * {@link CARD_KEYS}, plus the customer-quoted order ref ONLY as a mis-quote
 * heads-up — an order is bound to the ticket but the ref the customer wrote
 * doesn't match its name/confirmation number (or the order couldn't be
 * fetched, so a match is unprovable). With no bound order the Order panel
 * already shows the quoted ref; when it matches, it's redundant.
 *
 * `order` is tri-state: `"loading"` means the order fetch hasn't settled yet —
 * the heads-up slot renders as a skeleton row (a pending fetch proves nothing,
 * and showing the real value would make the row pop out once the order arrives
 * and matches); `null` means the fetch settled without an order, so a match is
 * unprovable and the heads-up shows.
 */
export const buildContextCardRows = (
  context: Readonly<Record<string, unknown>>,
  order: ContextCardOrder | "loading" | null,
): ContextRow[] => {
  const quoted = asString(context["quotedOrderRef"]);
  const bound = asString(context["identifiedOrderId"]);
  const settled = order === "loading" ? null : order;
  const quotedMatchesOrder =
    quoted !== null &&
    [settled?.name, settled?.confirmationNumber].some(
      (ref) =>
        typeof ref === "string" &&
        ref.length > 0 &&
        normalizeOrderRef(ref) === normalizeOrderRef(quoted),
    );
  const quotedPending = quoted !== null && bound !== null && order === "loading";
  const showQuoted =
    quoted !== null &&
    bound !== null &&
    !quotedPending &&
    !quotedMatchesOrder;
  return buildContextRows(context)
    .filter(
      (row) =>
        CARD_KEYS.has(row.key) ||
        (row.key === "quotedOrderRef" && (showQuoted || quotedPending)),
    )
    .map((row) =>
      row.key === "quotedOrderRef" && quotedPending
        ? { key: row.key, label: row.label, skeleton: true }
        : row,
    );
};

export const buildContextRows = (
  context: Readonly<Record<string, unknown>>,
): ContextRow[] => {
  const rows: ContextRow[] = [];

  const classification = asString(context["classification"]);
  if (classification)
    rows.push({
      key: "classification",
      label: "Category",
      text: humanizeSlug(classification),
    });

  const email = asString(context["customerEmail"]);
  if (email)
    rows.push({ key: "customerEmail", label: "Customer email", text: email, mono: true });

  // The order's email, confirmed by the requester on a mismatch ticket and stamped
  // by the runtime (never the model). Shown distinctly from the corresponding
  // `customerEmail`, which may be a typo or a different sender address.
  const verifiedEmail = asString(context["verifiedCustomerEmail"]);
  if (verifiedEmail)
    rows.push({
      key: "verifiedCustomerEmail",
      label: "Verified order email",
      text: verifiedEmail,
      mono: true,
    });

  const orderId = asString(context["identifiedOrderId"]);
  if (orderId)
    rows.push({ key: "identifiedOrderId", label: "Order", text: orderId, mono: true });

  const quotedOrderRef = asString(context["quotedOrderRef"]);
  if (quotedOrderRef)
    rows.push({
      key: "quotedOrderRef",
      label: "Customer-quoted order",
      text: quotedOrderRef,
      mono: true,
    });

  const customerId = asString(context["identifiedCustomerId"]);
  if (customerId)
    rows.push({
      key: "identifiedCustomerId",
      label: "Customer ID",
      text: customerId,
      mono: true,
    });

  const returnReason = parseReturnReason(context["returnReason"]);
  if (returnReason)
    rows.push({
      key: "returnReason",
      label: "Return reason",
      badges: [{ text: returnReasonLabel(returnReason), variant: "secondary" }],
    });

  const resolution = parseRequestedResolution(context["requestedResolution"]);
  if (resolution)
    rows.push({
      key: "requestedResolution",
      label: "Customer wants",
      badges: [
        { text: requestedResolutionLabel(resolution), variant: "secondary" },
      ],
    });

  const productMatch =
    typeof context["productMatch"] === "string"
      ? PRODUCT_MATCH[context["productMatch"]]
      : undefined;
  if (productMatch)
    rows.push({ key: "productMatch", label: "Photo check", badges: [productMatch] });

  const photos = formatPhotoSignals(context["photoSignals"]);
  if (photos) rows.push({ key: "photoSignals", label: "Photos", text: photos });

  const flags = Array.isArray(context["riskFlags"])
    ? context["riskFlags"].filter((f): f is string => typeof f === "string")
    : [];
  if (flags.length)
    rows.push({
      key: "riskFlags",
      label: "Risk flags",
      badges: buildRiskFlagBadges(flags).map((b) => ({
        text: b.text,
        variant: "destructive" as const,
        ...(b.ticketIds ? { ticketIds: b.ticketIds } : {}),
      })),
    });

  // `liveTrackingStatus` is rendered by the dedicated Tracking card, not here —
  // it stays in KNOWN_KEYS so the generic fallback below never dumps it as JSON.

  const notes = asString(context["notes"]);
  if (notes)
    rows.push({ key: "notes", label: "Notes", text: notes, multiline: true });

  // Stamped by `recordSupplierUpdate` (packages/db supplier-store) when a
  // supplier answers an escalation: { supplierId, note, proposedResolution }.
  // Both fields are supplier-typed free text; the internal supplierId is
  // deliberately not shown.
  const supplierUpdate = recordOf(context["supplierUpdate"]);
  const supplierNote = supplierUpdate ? asString(supplierUpdate["note"]) : null;
  if (supplierNote)
    rows.push({
      key: "supplierNote",
      label: "Supplier note",
      text: supplierNote,
      multiline: true,
    });
  const supplierProposedResolution = supplierUpdate
    ? asString(supplierUpdate["proposedResolution"])
    : null;
  if (supplierProposedResolution)
    rows.push({
      key: "supplierProposedResolution",
      label: "Supplier suggests",
      text: supplierProposedResolution,
      multiline: true,
    });
  // Files the supplier uploaded with the update ({ id, filename }[]); only
  // the filenames matter to the operator — ids are internal handles.
  const supplierAttachments = supplierUpdate
    ? supplierUpdate["attachments"]
    : null;
  if (Array.isArray(supplierAttachments) && supplierAttachments.length > 0) {
    const names = supplierAttachments
      .map((a) => (a && typeof a === "object" ? asString((a as Record<string, unknown>)["filename"]) : null))
      .filter((n): n is string => n !== null && n.length > 0);
    if (names.length > 0)
      rows.push({
        key: "supplierAttachments",
        label: "Supplier files",
        text: names.join(", "),
      });
  }

  // Anything the agent or runtime stamped that has no bespoke row above —
  // humanize the key and stringify the value so it's never silently hidden,
  // but the fields that matter still get the friendly treatment.
  for (const key of Object.keys(context)) {
    if (KNOWN_KEYS.has(key)) continue;
    const text = formatUnknown(context[key]);
    if (text) rows.push({ key, label: humanizeKey(key), text });
  }

  return rows;
};
