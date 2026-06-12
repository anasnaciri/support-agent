import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Signed Telegram linking token
// ============================================================
//
// The dashboard mints a deep link `https://t.me/<bot>?start=<token>`
// from an AUTHENTICATED endpoint; the merchant taps it and Telegram
// delivers `/start <token>` to our webhook, which binds the sending
// chat to the token's tenant. The token is the ONLY authorization on
// that webhook path, so it follows the install-grant rules (signed,
// short-lived, tenant-scoped — never a raw `?tenant=`).
//
// Telegram start parameters allow ≤64 chars of [A-Za-z0-9_-], which
// rules out the install grant's dot-separated format. Instead the
// token is one base64url blob of fixed-width binary fields:
//
//   uuid(16) ‖ expiresAtSeconds(8, BE) ‖ HMAC-SHA256(uuid‖exp)[0..16)
//
// 40 bytes → 54 base64url chars.

export const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const SIG_BYTES = 16;

const uuidToBytes = (uuid: string): Buffer =>
  Buffer.from(uuid.replaceAll("-", ""), "hex");

const bytesToUuid = (b: Buffer): string => {
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sign = (signingKey: string, payload: Buffer): Buffer =>
  createHmac("sha256", signingKey).update(payload).digest().subarray(0, SIG_BYTES);

export const mintTelegramLinkToken = (
  signingKey: string,
  tenantId: string,
  expiresAtMs: number,
): string => {
  if (!UUID_RE.test(tenantId)) {
    throw new Error("mintTelegramLinkToken: tenantId must be a uuid");
  }
  const payload = Buffer.alloc(24);
  uuidToBytes(tenantId).copy(payload, 0);
  payload.writeBigUInt64BE(BigInt(Math.floor(expiresAtMs / 1000)), 16);
  return Buffer.concat([payload, sign(signingKey, payload)]).toString(
    "base64url",
  );
};

export const verifyTelegramLinkToken = (
  signingKey: string,
  token: string,
  nowMs: number = Date.now(),
): { readonly tenantId: string } | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(token, "base64url");
  } catch {
    return null;
  }
  if (bytes.length !== 24 + SIG_BYTES) return null;
  const payload = bytes.subarray(0, 24);
  const sig = bytes.subarray(24);
  const expected = sign(signingKey, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  const expiresAtMs = Number(payload.readBigUInt64BE(16)) * 1000;
  if (nowMs >= expiresAtMs) return null;
  return { tenantId: bytesToUuid(payload.subarray(0, 16)) };
};
