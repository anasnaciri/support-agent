// Pure parsing + helpers for the ticket Tracking card. The agent stamps a
// tolerant `liveTrackingStatus` projection onto `ticket.context` (see
// `ticket.update_context`); this normalizes it into a shape the card can paint,
// dropping anything malformed so a bad stamp never crashes the page.

export type TrackingStatusValue =
  | "in_transit"
  | "delivered"
  | "exception"
  | "pending"
  | "unknown";

export interface ParsedTrackingScan {
  readonly occurredAt: string;
  readonly location: string | null;
  readonly description: string;
}

export interface ParsedTracking {
  readonly kind: "live" | "no_provider";
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly status: TrackingStatusValue | null;
  readonly lastScan: ParsedTrackingScan | null;
  readonly estimatedDeliveryAt: string | null;
  readonly trackingUrl: string | null;
  readonly reason: "no_api_key" | "unsupported_carrier" | "sync_pending" | null;
  // Rich fields from the live `ticketTracking` endpoint (absent on the narrower
  // on-ticket `liveTrackingStatus` stamp → null / []).
  readonly originCountry: string | null;
  readonly destinationCountry: string | null;
  readonly transitDays: number | null;
  readonly checkpoints: ReadonlyArray<ParsedTrackingScan>;
}

const STATUS_VALUES: ReadonlySet<string> = new Set([
  "in_transit",
  "delivered",
  "exception",
  "pending",
  "unknown",
]);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const parseScan = (v: unknown): ParsedTrackingScan | null => {
  const r = record(v);
  const occurredAt = str(r?.["occurredAt"]);
  if (!r || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  return {
    occurredAt,
    location: str(r["location"]),
    description: typeof r["description"] === "string" ? r["description"] : "",
  };
};

/**
 * Normalize `context.liveTrackingStatus` into {@link ParsedTracking}, or `null`
 * when it's absent / not a tracking stamp / carries nothing worth a card.
 */
export const parseLiveTracking = (value: unknown): ParsedTracking | null => {
  const r = record(value);
  if (!r) return null;
  const kind = r["kind"];
  if (kind !== "live" && kind !== "no_provider") return null;

  const statusRaw = r["status"];
  const status =
    typeof statusRaw === "string" && STATUS_VALUES.has(statusRaw)
      ? (statusRaw as TrackingStatusValue)
      : null;
  const reasonRaw = r["reason"];
  const reason =
    reasonRaw === "no_api_key" ||
    reasonRaw === "unsupported_carrier" ||
    reasonRaw === "sync_pending"
      ? reasonRaw
      : null;

  const checkpointsRaw = Array.isArray(r["checkpoints"]) ? r["checkpoints"] : [];
  const checkpoints = checkpointsRaw
    .map(parseScan)
    .filter((s): s is ParsedTrackingScan => s !== null);

  const parsed: ParsedTracking = {
    kind,
    trackingNumber: str(r["trackingNumber"]),
    carrier: str(r["carrier"]),
    status,
    lastScan: parseScan(r["lastScan"]),
    estimatedDeliveryAt: str(r["estimatedDeliveryAt"]),
    trackingUrl: str(r["trackingUrl"]),
    reason,
    originCountry: str(r["originCountry"]),
    destinationCountry: str(r["destinationCountry"]),
    transitDays:
      typeof r["transitDays"] === "number" && Number.isFinite(r["transitDays"])
        ? r["transitDays"]
        : null,
    checkpoints,
  };

  // Nothing useful to show → no card.
  if (
    !parsed.trackingNumber &&
    !parsed.status &&
    !parsed.lastScan &&
    !parsed.carrier
  ) {
    return null;
  }
  return parsed;
};

/**
 * Suppress an on-ticket stamp that no longer describes the order's shipment.
 * The stamp is a snapshot of the agent's LAST `tracking.lookup`; when the
 * order's fulfillment now tracks under a different number (a reship, a
 * re-label, a Shopify-admin edit) the snapshot is superseded and rendering it
 * would show the old number and its stale scans as this order's status.
 * A resolved order is canonical even when all tracking was removed. When the
 * order could not be resolved, the stamp remains as a fail-open fallback. A
 * destination-mismatch stamp remains visible for human review when the order
 * has no tracking of its own; a different current order number still wins.
 */
export const dropSupersededStamp = (
  stamp: ParsedTracking | null,
  orderTrackingNumbers: ReadonlyArray<string>,
  orderResolved = orderTrackingNumbers.length > 0,
  riskFlags: ReadonlyArray<string> = [],
): ParsedTracking | null => {
  if (!stamp?.trackingNumber) return stamp;
  if (!orderResolved) return stamp;
  if (
    orderTrackingNumbers.length === 0 &&
    riskFlags.includes("tracking_destination_mismatch")
  ) {
    return stamp;
  }
  return orderTrackingNumbers.includes(stamp.trackingNumber) ? stamp : null;
};

export const TRACKING_STATUS_LABEL: Record<TrackingStatusValue, string> = {
  in_transit: "In transit",
  delivered: "Delivered",
  exception: "Delivery exception",
  pending: "Label created",
  unknown: "Status unknown",
};

export const trackingStatusVariant = (
  status: TrackingStatusValue,
): "success" | "warning" | "destructive" | "muted" | "default" => {
  switch (status) {
    case "delivered":
      return "success";
    case "in_transit":
      return "default";
    case "exception":
      return "destructive";
    case "pending":
      return "muted";
    default:
      return "muted";
  }
};

/** 17track's public lookup page accepts a bare number + auto-detects carrier. */
export const publicTrackingUrl = (trackingNumber: string): string =>
  `https://t.17track.net/en#nums=${encodeURIComponent(trackingNumber)}`;

export const trackingUrlFor = (t: ParsedTracking): string | null =>
  t.trackingUrl ??
  (t.trackingNumber ? publicTrackingUrl(t.trackingNumber) : null);

/**
 * Whole days between `from` and `now`. Accepts an ISO string or Date (Path B
 * serializes dates to strings). Returns null for an unparseable or future date.
 */
export const daysBetween = (
  from: string | Date | null | undefined,
  nowMs: number,
): number | null => {
  if (from == null) return null;
  const t = from instanceof Date ? from.getTime() : Date.parse(from);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((nowMs - t) / 86_400_000);
  return days >= 0 ? days : null;
};
