// Reads connector health off a connection's jsonb metadata for the dashboard.
//
// The worker's renewal/poll crons stamp health into `connector_connections`
// metadata after every pass (see apps/worker/src/connector-health.ts):
//   - `connectorHealth`        "ok" | "broken"
//   - `connectorHealthReason`  a RAW provider failure string, or null
//   - `connectorHealthAt`      an ISO timestamp, or null
// The api projects the whole jsonb blob, so each ConnectorConnectionView's
// `metadata: unknown` already carries these on the wire. This module is the
// dashboard-side parse + humanize: it reads the `unknown` blob safely and turns
// the raw reason into merchant-friendly copy. Nothing code-flavored — provider
// error codes, status numbers, colon-delimited internals — may reach the UI;
// unknown reasons collapse to a generic "needs reconnecting", mirroring how
// lib/labels.ts humanizes unknown enums.

export type ConnectorHealthState = "ok" | "broken";

export interface ConnectorHealthResult {
  readonly state: ConnectorHealthState;
  /** The raw stamped reason (used only to derive merchant copy), or null. */
  readonly reason: string | null;
  /** ISO timestamp of the last health check, or null. */
  readonly at: string | null;
}

const HEALTHY: ConnectorHealthResult = {
  state: "ok",
  reason: null,
  at: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Safely read connector health from a connection's `metadata: unknown`.
 * Defaults to a healthy result on absent or malformed metadata, so legacy rows
 * (stamped before health tracking) and non-object blobs render exactly as a
 * healthy connector does today.
 */
export const connectorHealth = (metadata: unknown): ConnectorHealthResult => {
  if (!isRecord(metadata)) return HEALTHY;
  if (metadata["connectorHealth"] !== "broken") return HEALTHY;
  return {
    state: "broken",
    reason: stringOrNull(metadata["connectorHealthReason"]),
    at: stringOrNull(metadata["connectorHealthAt"]),
  };
};

// Merchant-friendly copy for the few failure shapes the crons actually stamp.
// Matched on substrings of the raw reason (lower-cased) so we don't depend on
// the exact provider wording, which differs across Gmail / Graph / IMAP and can
// change. Anything we don't recognise falls through to the generic prompt — the
// raw text is never rendered.
const SIGNED_OUT =
  "The connection was signed out. Reconnect to restore access.";
const ACCESS_REJECTED =
  "Access was no longer accepted. Reconnect to grant access again.";
const SUBSCRIPTION_LAPSED =
  "The mailbox stopped delivering new messages. Reconnect to resume.";
const GENERIC = "This connection needs reconnecting.";

/**
 * Turn a raw stamped reason into plain merchant copy. A null/empty reason or
 * any unrecognised text collapses to the generic reconnect prompt — never a
 * code, status number, or internal phrasing.
 */
export const connectorHealthReasonLabel = (
  reason: string | null | undefined,
): string => {
  if (!reason) return GENERIC;
  const r = reason.toLowerCase();

  // A missing or rejected refresh token — the connection was effectively
  // signed out and only re-consent fixes it.
  if (
    r.includes("no refresh token") ||
    r.includes("invalid_grant") ||
    r.includes("invalid grant") ||
    r.includes("revoked")
  ) {
    return SIGNED_OUT;
  }

  // A lapsed Microsoft Graph subscription — inbound delivery stopped.
  if (r.includes("subscription")) return SUBSCRIPTION_LAPSED;

  // A token that no longer authenticates (expired credential, 401/403).
  if (
    r.includes("unauthor") ||
    r.includes("expired") ||
    r.includes("401") ||
    r.includes("403") ||
    r.includes("auth")
  ) {
    return ACCESS_REJECTED;
  }

  return GENERIC;
};
