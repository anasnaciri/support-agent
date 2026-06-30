// Pure parsing + helpers for the case Tracking card. The agent stamps a
// tolerant `liveTrackingStatus` projection onto `case.context` (see
// `case.update_context`); this normalizes it into a shape the card can paint,
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
  readonly reason: "no_api_key" | "unsupported_carrier" | null;
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
  if (!r || !occurredAt) return null;
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
    reasonRaw === "no_api_key" || reasonRaw === "unsupported_carrier"
      ? reasonRaw
      : null;

  const parsed: ParsedTracking = {
    kind,
    trackingNumber: str(r["trackingNumber"]),
    carrier: str(r["carrier"]),
    status,
    lastScan: parseScan(r["lastScan"]),
    estimatedDeliveryAt: str(r["estimatedDeliveryAt"]),
    trackingUrl: str(r["trackingUrl"]),
    reason,
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
