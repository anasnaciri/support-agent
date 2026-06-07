import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Signed OAuth install grant
// ============================================================
//
// The connector install endpoints (`/shopify/install`, `/google/install`) are
// browser redirects — the api can't see the merchant's WorkOS session there.
// Trusting a raw `?tenant=<uuid>` let anyone start an OAuth flow that binds
// THEIR provider account to a victim tenant (5th-audit #2). Instead, the
// dashboard mints a short-lived, signed grant via an AUTHENTICATED endpoint
// (which proves, through the dashboard's WorkOS session + org→tenant mapping,
// that the user owns the tenant), and the install endpoints require it.
//
// A grant is `base64url(`${tenantId}.${provider}.${expiresAtMs}`).base64url(sig)`
// signed with HMAC-SHA256. It is provider-scoped and expires quickly.

export type InstallGrantProvider = "shopify" | "gmail" | "google_sheets";

const GRANT_PROVIDERS: ReadonlyArray<InstallGrantProvider> = [
  "shopify",
  "gmail",
  "google_sheets",
];

export const isInstallGrantProvider = (
  p: string,
): p is InstallGrantProvider =>
  (GRANT_PROVIDERS as ReadonlyArray<string>).includes(p);

/** Default grant lifetime: long enough to click through, short enough to limit
 * replay. */
export const INSTALL_GRANT_TTL_MS = 10 * 60 * 1000;

export interface InstallGrant {
  readonly tenantId: string;
  readonly provider: InstallGrantProvider;
}

const b64url = (b: Buffer): string => b.toString("base64url");

export const signInstallGrant = (
  signingKey: string,
  grant: InstallGrant,
  expiresAtMs: number,
): string => {
  const payload = `${grant.tenantId}.${grant.provider}.${expiresAtMs}`;
  const sig = createHmac("sha256", signingKey).update(payload).digest();
  return `${b64url(Buffer.from(payload, "utf8"))}.${b64url(sig)}`;
};

/**
 * Verify a grant token. Returns the grant when the signature is valid, the
 * provider is recognized, and it has not expired; otherwise `null`.
 */
export const verifyInstallGrant = (
  signingKey: string,
  token: string,
  nowMs: number = Date.now(),
): InstallGrant | null => {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = Buffer.from(encodedPayload, "base64url");
    sig = Buffer.from(encodedSig, "base64url");
  } catch {
    return null;
  }
  const payload = payloadBytes.toString("utf8");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;

  const segments = payload.split(".");
  if (segments.length !== 3) return null;
  const [tenantId, provider, expiresRaw] = segments;
  if (!tenantId || !provider || !expiresRaw) return null;
  if (!isInstallGrantProvider(provider)) return null;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) return null;

  return { tenantId, provider };
};
