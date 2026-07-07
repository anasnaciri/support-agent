import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Approval link tokens
// ============================================================
//
// When the runtime parks a ticket in `waiting_for_approval`, the platform
// emails the merchant's operator with two URLs:
//
//   GET /approvals/:id/approve?token=<sig>   (renders a confirm page)
//   GET /approvals/:id/reject?token=<sig>
//
// The GET renders a confirmation page whose form POSTs the same token
// back — only the POST mutates (audit S2: email-security scanners
// follow GET links, and must not be able to decide an approval).
//
// The token is a stateless, HMAC-signed cryptogram binding the approval
// id AND the action to an expiry (audit S3: approve and reject carry
// different tokens, so holding a reject link doesn't let you approve by
// editing the path). It carries enough auth on its own — no server-side
// session, no per-link table row. Verification is constant-time.
//
// Format: `<approvalId>.<action>.<expiresAtMs>.<b64url(HMAC-SHA256(secret, body))>`
// where `body = "<approvalId>.<action>.<expiresAtMs>"`. We use base64url
// (RFC 4648 §5) so the token drops into a URL without %-encoding.

const HMAC_ALGO = "sha256";

export type ApprovalTokenAction = "approve" | "reject";

const isApprovalTokenAction = (s: string): s is ApprovalTokenAction =>
  s === "approve" || s === "reject";

const b64urlEncode = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");

const b64urlDecode = (s: string): Buffer => {
  // Pad to a multiple of 4 before swapping back into stock base64.
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const stock = s.replace(/-/gu, "+").replace(/_/gu, "/") + pad;
  return Buffer.from(stock, "base64");
};

export interface SignApprovalTokenInput {
  readonly approvalId: string;
  /** The decision this token authorizes — bound into the HMAC body. */
  readonly action: ApprovalTokenAction;
  readonly secret: string;
  /**
   * Time-to-live in milliseconds. Default 24 hours — matches the
   * `expiresAt` the runtime stamps on the approval row, so a link can
   * never outlive the approval it points at (audit S3: the previous
   * 7-day default left a long-lived bearer capability in inboxes and
   * request logs).
   */
  readonly ttlMs?: number;
  /** Clock override for tests. */
  readonly nowMs?: number;
}

// The emailed approve/reject link is a bearer credential sitting in a
// manager's inbox, so it still carries a TTL (the authenticated dashboard
// is the no-expiry path). 30 days: long enough that a manager who acts
// days later isn't dead-ended, short enough to cap a leaked-link window.
// NOTE: this bounds only the signed LINK — the approval row itself no
// longer expires; tool age never blocks a decision.
export const DEFAULT_APPROVAL_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const signApprovalToken = (input: SignApprovalTokenInput): string => {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TOKEN_TTL_MS;
  const expiresAt = now + ttl;
  // Approval ids never contain `.` (they're UUIDs) and the action is a
  // fixed enum, so `.` is a safe separator. If we ever widen the id
  // format, swap to a length-prefix encoding — until then this is the
  // simplest thing that works.
  const body = `${input.approvalId}.${input.action}.${expiresAt}`;
  const sig = createHmac(HMAC_ALGO, input.secret).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
};

export type VerifyApprovalTokenResult =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly action: ApprovalTokenAction;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "invalid_signature" | "expired";
    };

export interface VerifyApprovalTokenInput {
  readonly token: string;
  readonly secret: string;
  /** Clock override for tests. */
  readonly nowMs?: number;
}

export const verifyApprovalToken = (
  input: VerifyApprovalTokenInput,
): VerifyApprovalTokenResult => {
  const parts = input.token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [approvalId, action, expiresAtStr, sigB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!approvalId || !action || !expiresAtStr || !sigB64) {
    return { ok: false, reason: "malformed" };
  }
  if (!isApprovalTokenAction(action)) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const body = `${approvalId}.${action}.${expiresAtStr}`;
  const expected = createHmac(HMAC_ALGO, input.secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (provided.length !== expected.length) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Check expiry AFTER signature so an attacker can't differentiate
  // between "bad sig" and "expired" by side channel.
  const now = input.nowMs ?? Date.now();
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, approvalId, action, expiresAt };
};

// ============================================================
// Bundle review tokens
// ============================================================
//
// The autonomous loop parks a ticket with SEVERAL queued approvals at
// once; the merchant ping carries ONE link to a review page that lists
// the whole bundle before any decision (a bundle must never be decidable
// sight-unseen — the S2 scanner problem applies doubly to Telegram,
// whose preview fetcher follows every sent URL).
//
// Same cryptogram format as the single-approval token, with the ticket
// id in the id slot and the fixed action `bundle_review`. That action
// string is deliberately outside the single-token enum, so neither
// token kind verifies on the other surface: an approve link can't open
// a review page, and a review link can't decide a single approval.

const BUNDLE_REVIEW_ACTION = "bundle_review";

export interface SignBundleReviewTokenInput {
  readonly ticketId: string;
  readonly secret: string;
  /** Time-to-live in milliseconds. Defaults to the 30-day link TTL. */
  readonly ttlMs?: number;
  /** Clock override for tests. */
  readonly nowMs?: number;
}

export const signBundleReviewToken = (
  input: SignBundleReviewTokenInput,
): string => {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TOKEN_TTL_MS;
  const expiresAt = now + ttl;
  const body = `${input.ticketId}.${BUNDLE_REVIEW_ACTION}.${expiresAt}`;
  const sig = createHmac(HMAC_ALGO, input.secret).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
};

export type VerifyBundleReviewTokenResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "invalid_signature" | "expired";
    };

export const verifyBundleReviewToken = (
  input: VerifyApprovalTokenInput,
): VerifyBundleReviewTokenResult => {
  const parts = input.token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [ticketId, action, expiresAtStr, sigB64] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!ticketId || !expiresAtStr || !sigB64) {
    return { ok: false, reason: "malformed" };
  }
  if (action !== BUNDLE_REVIEW_ACTION) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const body = `${ticketId}.${action}.${expiresAtStr}`;
  const expected = createHmac(HMAC_ALGO, input.secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (provided.length !== expected.length) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Expiry AFTER signature — same side-channel reasoning as above.
  const now = input.nowMs ?? Date.now();
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, ticketId, expiresAt };
};
