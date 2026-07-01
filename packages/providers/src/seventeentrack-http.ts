// ============================================================
// 17track API — low-level wire format
// ============================================================
//
// Plain async functions over `fetch` (no Effect Tag — `TrackingServiceLive`
// wraps these). Same shape pattern as `gmail-http.ts` so the providers
// are reviewable side-by-side.
//
// API surface used today:
//   - POST /track/v2.2/register     — pre-register the number(s) we'll query
//   - POST /track/v2.2/gettrackinfo — fetch latest status for the number(s)
//
// 17track's docs: https://www.17track.net/en/api

import type {
  TrackingScanEvent,
  TrackingStatus,
} from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export type SeventeenTrackHttpFailure =
  | { readonly kind: "auth_failed"; readonly status: number }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "not_found"; readonly status: number }
  | { readonly kind: "invalid"; readonly status: number; readonly message: string }
  | { readonly kind: "network"; readonly status: number; readonly body: string };

export class SeventeenTrackHttpError extends Error {
  readonly failure: SeventeenTrackHttpFailure;
  constructor(failure: SeventeenTrackHttpFailure, message: string) {
    super(message);
    this.failure = failure;
    this.name = "SeventeenTrackHttpError";
  }
}

// ============================================================
// Internal fetch wrapper
// ============================================================

const BASE = "https://api.17track.net";

interface RequestOpts {
  readonly path: string;
  readonly apiKey: string;
  readonly body: unknown;
  readonly fetchImpl?: typeof fetch;
}

const post = async (opts: RequestOpts): Promise<unknown> => {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${BASE}${opts.path}`, {
    method: "POST",
    headers: {
      "17token": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new SeventeenTrackHttpError(
        { kind: "auth_failed", status: res.status },
        `17track ${opts.path}: ${res.status}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      throw new SeventeenTrackHttpError(
        { kind: "rate_limited", retryAfterMs: retryAfter * 1000 },
        `17track ${opts.path}: 429`,
      );
    }
    if (res.status === 404) {
      throw new SeventeenTrackHttpError(
        { kind: "not_found", status: 404 },
        `17track ${opts.path}: 404`,
      );
    }
    throw new SeventeenTrackHttpError(
      { kind: "network", status: res.status, body: text },
      `17track ${opts.path}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as unknown;
};

// ============================================================
// Wire types — only the bits we read
// ============================================================
//
// 17track's response envelope:
// {
//   "code": 0,
//   "data": {
//     "accepted": [ { "number": "...", "carrier": 100002, "track": {...} } ],
//     "rejected": [ { "number": "...", "error": { "code": ..., "message": "..." } } ]
//   }
// }
//
// `track` inside `accepted[*]`:
// {
//   "e": 40,            // event/status code — 40=delivered, 30=in_transit, ...
//   "z0": { "a": "2026-05-23T12:00:00Z", "z": "...", "c": "...location..." },  // last event
//   "z1": [ ...all events... ],
//   ...
// }

interface RawTrackEvent {
  readonly a?: string;
  readonly c?: string;
  readonly z?: string;
}

interface RawAddress {
  readonly country?: string;
  readonly state?: string;
  readonly city?: string;
}

interface RawProviderEvent {
  readonly time_iso?: string;
  readonly time_utc?: string;
  readonly location?: string;
  readonly description?: string;
  readonly address?: RawAddress;
}

interface RawTrackInfo {
  readonly latest_event?: {
    readonly time_iso?: string;
    readonly location?: string;
    readonly description?: string;
  };
  readonly latest_status?: {
    readonly status?: string;
  };
  readonly estimated_delivery_date?: {
    readonly source?: string;
    readonly from?: string;
    readonly to?: string;
  };
  readonly shipping_info?: {
    readonly shipper_address?: RawAddress;
    readonly recipient_address?: RawAddress;
  };
  readonly time_metrics?: {
    readonly days_after_order?: number;
    readonly days_of_transit?: number;
  };
  readonly tracking?: {
    readonly providers?: ReadonlyArray<{
      readonly events?: ReadonlyArray<RawProviderEvent>;
    }>;
  };
}

interface RawTrack {
  readonly e?: number;
  readonly z0?: RawTrackEvent;
  readonly track_info?: RawTrackInfo;
}

interface RawAccepted {
  readonly number: string;
  readonly carrier?: number | string;
  readonly track?: RawTrack;
  readonly track_info?: RawTrack["track_info"];
}

interface RawRejected {
  readonly number: string;
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface RawEnvelope {
  readonly code?: number;
  readonly data?: {
    readonly accepted?: ReadonlyArray<RawAccepted>;
    readonly rejected?: ReadonlyArray<RawRejected>;
  };
}

// ============================================================
// Status code mapping
// ============================================================
//
// 17track uses numeric codes in `track.e` AND string codes in
// `track_info.latest_status.status`. We normalize both into our
// `TrackingStatus` union.

const numericToStatus = (e: number | undefined): TrackingStatus => {
  if (e === undefined) return "unknown";
  if (e === 40) return "delivered";
  if (e === 30 || e === 35) return "in_transit";
  if (e === 0 || e === 5 || e === 10) return "pending";
  if (e === 50) return "exception";
  return "unknown";
};

const stringToStatus = (s: string | undefined): TrackingStatus => {
  if (!s) return "unknown";
  const lower = s.toLowerCase();
  if (lower.includes("delivered")) return "delivered";
  if (lower.includes("intransit") || lower.includes("in_transit") || lower.includes("transit")) {
    return "in_transit";
  }
  if (lower.includes("pending") || lower.includes("notfound") || lower.includes("info_received")) {
    return "pending";
  }
  if (lower.includes("exception") || lower.includes("undelivered") || lower.includes("expired")) {
    return "exception";
  }
  return "unknown";
};

// ============================================================
// Public API
// ============================================================

export interface SeventeenTrackRegisterInput {
  readonly apiKey: string;
  readonly trackingNumber: string;
  readonly carrier?: string | number | null;
  /**
   * Language code 17track translates logistics events into. Defaults to `en`
   * so a Chinese-origin shipment's checkpoints come back in English. 17track
   * translates at registration time (on the next event change), so this must be
   * set when the number is registered — which our lookup flow always does first.
   */
  readonly lang?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pre-register a tracking number with 17track. Required by the v2.2
 * API before `gettrackinfo` will return data. Idempotent — registering
 * the same number twice is a no-op on 17track's side.
 *
 * The endpoint accepts a carrier hint but auto-detects when omitted;
 * we pass the carrier through only when the caller had one to give
 * (from Shopify's `fulfillment.trackingCompany`).
 */
export const seventeenTrackRegister = async (
  input: SeventeenTrackRegisterInput,
): Promise<void> => {
  const body: Array<Record<string, unknown>> = [
    {
      number: input.trackingNumber,
      ...(input.carrier ? { carrier: input.carrier } : {}),
      lang: input.lang ?? "en",
    },
  ];
  await post({
    path: "/track/v2.2/register",
    apiKey: input.apiKey,
    body,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
};

export interface SeventeenTrackGetInfoInput {
  readonly apiKey: string;
  readonly trackingNumber: string;
  readonly fetchImpl?: typeof fetch;
}

export interface SeventeenTrackInfo {
  readonly carrier: string;
  readonly status: TrackingStatus;
  readonly lastScan: TrackingScanEvent | null;
  readonly estimatedDeliveryAt: Date | null;
  readonly originCountry: string | null;
  readonly destinationCountry: string | null;
  /** Days the shipment has been in transit, per 17track's time metrics. */
  readonly transitDays: number | null;
  /** Full carrier checkpoint list, newest-first (17track's event order). */
  readonly checkpoints: ReadonlyArray<TrackingScanEvent>;
}

// Compose a human location from a flat string, else the structured address.
const composeLocation = (
  flat: string | undefined,
  address: RawAddress | undefined,
): string | null => {
  if (typeof flat === "string" && flat.trim().length > 0) return flat;
  if (!address) return null;
  const parts = [address.city, address.state, address.country].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
};

const parseCheckpoints = (
  info: RawTrackInfo | undefined,
): ReadonlyArray<TrackingScanEvent> => {
  const events = info?.tracking?.providers?.[0]?.events ?? [];
  const out: TrackingScanEvent[] = [];
  for (const e of events) {
    const iso = e.time_iso ?? e.time_utc;
    if (!iso) continue;
    const occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime())) continue;
    out.push({
      occurredAt,
      location: composeLocation(e.location, e.address),
      description: e.description ?? "",
    });
  }
  return out;
};

/**
 * Fetch the latest status for a single registered tracking number.
 * Returns `null` when the number is in `rejected[]` (unsupported
 * carrier / unknown format) — callers translate that into a
 * `TrackingLookup.no_provider` with `reason: "unsupported_carrier"`.
 */
export const seventeenTrackGetInfo = async (
  input: SeventeenTrackGetInfoInput,
): Promise<SeventeenTrackInfo | null> => {
  const body: Array<Record<string, unknown>> = [
    { number: input.trackingNumber },
  ];
  const raw = (await post({
    path: "/track/v2.2/gettrackinfo",
    apiKey: input.apiKey,
    body,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })) as RawEnvelope;

  const accepted = raw.data?.accepted?.[0];
  if (!accepted) {
    return null;
  }
  const track = accepted.track ?? {};
  const info = accepted.track_info ?? track.track_info;
  const carrier = String(accepted.carrier ?? "unknown");

  // Status: prefer numeric event code when present, fall back to
  // string status from track_info.
  const status =
    track.e !== undefined
      ? numericToStatus(track.e)
      : stringToStatus(info?.latest_status?.status);

  // Last scan: prefer the modern track_info.latest_event shape, fall
  // back to the legacy z0 fields.
  let lastScan: TrackingScanEvent | null = null;
  if (info?.latest_event?.time_iso) {
    const occurredAt = new Date(info.latest_event.time_iso);
    if (!Number.isNaN(occurredAt.getTime())) {
      lastScan = {
        occurredAt,
        location: info.latest_event.location ?? null,
        description: info.latest_event.description ?? "",
      };
    }
  } else if (track.z0?.a) {
    const occurredAt = new Date(track.z0.a);
    if (!Number.isNaN(occurredAt.getTime())) {
      lastScan = {
        occurredAt,
        location: track.z0.c ?? null,
        description: track.z0.z ?? "",
      };
    }
  }

  // ETA: 17track surfaces a range (`from` .. `to`). Pick `to` as the
  // upper bound — that's what we'd quote a customer.
  let estimatedDeliveryAt: Date | null = null;
  const etaTo = info?.estimated_delivery_date?.to;
  if (etaTo) {
    const d = new Date(etaTo);
    if (!Number.isNaN(d.getTime())) estimatedDeliveryAt = d;
  }

  const originCountry = info?.shipping_info?.shipper_address?.country ?? null;
  const destinationCountry =
    info?.shipping_info?.recipient_address?.country ?? null;
  const transitDays =
    typeof info?.time_metrics?.days_of_transit === "number"
      ? info.time_metrics.days_of_transit
      : typeof info?.time_metrics?.days_after_order === "number"
        ? info.time_metrics.days_after_order
        : null;
  const checkpoints = parseCheckpoints(info);

  return {
    carrier,
    status,
    lastScan,
    estimatedDeliveryAt,
    originCountry,
    destinationCountry,
    transitDays,
    checkpoints,
  };
};
