/**
 * Turns a case's freeform `context` blob into an ordered list of operator-
 * friendly rows for the Context panel — labeled fields and chips instead of a
 * raw JSON dump. The known keys mirror `case.update_context`'s closed schema
 * (packages/tools) plus the runtime-reserved keys (`customerEmail`,
 * `riskFlags`, `photoSignals`); anything else is humanized as a fallback row so
 * a newly-added backend field is still visible while it waits for a real label.
 */
import type { BadgeProps } from "@/components/ui/badge";
import { humanizeSlug } from "../../../lib/labels";
import {
  parseRequestedResolution,
  parseReturnReason,
  requestedResolutionLabel,
  returnReasonLabel,
} from "./return-labels";
import { riskFlagLabel } from "./risk-flag-label";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export interface ContextBadge {
  readonly text: string;
  readonly variant: BadgeVariant;
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
}

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Humanize an unknown context KEY for a fallback row. Unlike the shared
 * `humanizeSlug` (built for snake_case slugs), context keys are camelCase
 * (`someFutureField`), so split on case boundaries too → "Some future field".
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

const TRACKING_STATUS: Readonly<Record<string, string>> = {
  in_transit: "In transit",
  delivered: "Delivered",
  exception: "Delivery exception",
  pending: "Label created",
  unknown: "Status unknown",
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

const formatTracking = (v: unknown): string | null => {
  const r = recordOf(v);
  if (!r) return null;
  if (r["kind"] === "no_provider") return "Live tracking unavailable";
  const status =
    typeof r["status"] === "string"
      ? (TRACKING_STATUS[r["status"]] ?? humanizeSlug(r["status"]))
      : null;
  const carrier = asString(r["carrier"]);
  const parts = [status, carrier].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
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
  "identifiedOrderId",
  "identifiedCustomerId",
  "returnReason",
  "requestedResolution",
  "productMatch",
  "photoSignals",
  "riskFlags",
  "liveTrackingStatus",
  "notes",
]);

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

  const orderId = asString(context["identifiedOrderId"]);
  if (orderId)
    rows.push({ key: "identifiedOrderId", label: "Order", text: orderId, mono: true });

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
      badges: flags.map((f) => ({ text: riskFlagLabel(f), variant: "destructive" })),
    });

  const tracking = formatTracking(context["liveTrackingStatus"]);
  if (tracking)
    rows.push({ key: "liveTrackingStatus", label: "Shipment", text: tracking });

  const notes = asString(context["notes"]);
  if (notes)
    rows.push({ key: "notes", label: "Notes", text: notes, multiline: true });

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
