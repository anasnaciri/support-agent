// ============================================================
// PII redaction for audit log details
// ============================================================
//
// The `audit_log.details` JSONB column can capture free-form context
// from the runtime — most fields are structural (tool name, ok flag,
// case id, turn number) but a few carry customer PII:
//
//   - `finalMessage` (agent's customer-facing reply text)
//   - `bodyText` / `bodyHtml` (when a tool input gets logged)
//   - `customerEmail`, `from.email`, `to[].email`
//   - `firstName`, `lastName`, `name`, `phone`, `address1`, `address2`
//
// This module provides a pure `redactPii(details)` function that walks
// the object and produces a sibling shape where:
//   1. String values under known-PII keys are replaced with "[redacted]".
//   2. Any other string value has email + phone patterns scrubbed.
//
// Structural fields (tool, ok, turn, id, decisionType, action) pass
// through untouched so the audit timeline stays readable for ops.
//
// Pure — no I/O, deterministic. Exposed for the wrapper layer below
// AND for direct use by OTel exporters / log forwarders later.

const PII_KEYS = new Set<string>([
  // Customer-facing reply bodies
  "bodyText",
  "bodyHtml",
  "finalMessage",
  // Identifiers
  "email",
  "customerEmail",
  "phone",
  // Person names — when these show up alongside customer data, redact.
  // We don't redact "name" of agents or merchants because agent ids are
  // already in the actorId column, not in details.
  "firstName",
  "lastName",
  // Address blocks
  "address1",
  "address2",
  "city",
  "province",
  "country",
  "zip",
]);

// Reasonable email + phone regex — error on the side of OVER-scrubbing.
// E.164-ish phone (8+ digits with optional + and separators).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

const REDACTED = "[redacted]";

const scrubString = (value: string): string =>
  value.replace(EMAIL_RE, REDACTED).replace(PHONE_RE, REDACTED);

/**
 * Walk `value` and produce a sibling structure with PII redacted.
 *
 *   - Strings whose KEY is in `PII_KEYS` → `"[redacted]"`.
 *   - Other strings → scrubbed of email + phone patterns.
 *   - Arrays / objects → recursed; keys preserved.
 *   - Primitives (number, boolean, null) → returned unchanged.
 *
 * The function is total — any input shape (including malformed
 * details from old audit rows) flows through without throwing.
 */
export const redactPii = (value: unknown): unknown => {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redactPii(v));
  if (value && typeof value === "object") {
    const obj = value as Readonly<Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (PII_KEYS.has(k) && typeof v === "string") {
        out[k] = REDACTED;
      } else {
        out[k] = redactPii(v);
      }
    }
    return out;
  }
  return value;
};

/**
 * Redact every string value at the top level of a details record,
 * cast to the audit-log details shape. Wrapper around `redactPii`
 * that preserves the `Readonly<Record<string, unknown>>` type contract
 * the AuditLogService expects.
 *
 * Wired into the audit insert path by the redacted variant of
 * `AuditLogServiceLive` in `packages/db` — operators opt in via the
 * `AUDIT_LOG_REDACT_PII=1` env var. Default dev/test runs keep the
 * un-redacted variant for full debug fidelity.
 */
export const redactDetails = (
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  redactPii(details) as Readonly<Record<string, unknown>>;
