import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Approval link tokens
// ============================================================
//
// When the runtime parks a case in `waiting_for_approval`, the platform
// emails the merchant's operator with two one-click URLs:
//
//   GET /approvals/:id/approve?token=<sig>
//   GET /approvals/:id/reject?token=<sig>
//
// The token is a stateless, HMAC-signed cryptogram binding the approval
// id to an expiry. It carries enough auth on its own — no server-side
// session, no per-link table row. Verification is constant-time.
//
// Format: `<approvalId>.<expiresAtMs>.<b64url(HMAC-SHA256(secret, body))>`
// where `body = "<approvalId>.<expiresAtMs>"`. We use base64url (RFC 4648
// §5) so the token drops into a URL without %-encoding.

const HMAC_ALGO = "sha256";

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
  readonly secret: string;
  /** Time-to-live in milliseconds. Default 7 days. */
  readonly ttlMs?: number;
  /** Clock override for tests. */
  readonly nowMs?: number;
}

export const signApprovalToken = (input: SignApprovalTokenInput): string => {
  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const expiresAt = now + ttl;
  // Approval ids never contain `.` (they're UUIDs), so `.` is a safe
  // separator. If we ever widen the id format, swap to a length-prefix
  // encoding — until then this is the simplest thing that works.
  const body = `${input.approvalId}.${expiresAt}`;
  const sig = createHmac(HMAC_ALGO, input.secret).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
};

export type VerifyApprovalTokenResult =
  | {
      readonly ok: true;
      readonly approvalId: string;
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
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [approvalId, expiresAtStr, sigB64] = parts as [string, string, string];
  if (!approvalId || !expiresAtStr || !sigB64) {
    return { ok: false, reason: "malformed" };
  }
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { ok: false, reason: "malformed" };
  }

  const body = `${approvalId}.${expiresAtStr}`;
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

  return { ok: true, approvalId, expiresAt };
};
