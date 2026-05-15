import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { computeHmac } from "@support-agent/services";

// ============================================================
// Shopify managed-install OAuth: pure helpers
// ============================================================
//
// This module deliberately exposes no HTTP: it builds + verifies the
// strings that the install / callback routes care about, so all the
// crypto + parsing is unit-testable without a server.

// ------------------------------------------------------------
// Shop-domain validation
// ------------------------------------------------------------

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const isValidShopDomain = (shop: string): boolean =>
  shop.length <= 100 && SHOP_RE.test(shop);

// ------------------------------------------------------------
// State signing (tenant binding through the OAuth redirect)
// ------------------------------------------------------------
//
// Shopify echoes our `state` value back to the callback unchanged. We
// stuff the tenantId + a random nonce into it and sign the pair with
// HMAC so the callback can recover the tenantId and reject tampered or
// forged states. `state` is base64url(`${tenantId}.${nonce}.${sig}`).

const b64url = (b: Buffer): string =>
  b.toString("base64url");

const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

export interface SignedStatePayload {
  readonly tenantId: string;
  readonly nonce: string;
}

export const signState = (
  signingKey: string,
  tenantId: string,
  nonce?: string,
): string => {
  const n = nonce ?? b64url(randomBytes(16));
  const payload = `${tenantId}.${n}`;
  const sig = createHmac("sha256", signingKey).update(payload).digest();
  return `${b64url(Buffer.from(payload, "utf8"))}.${b64url(sig)}`;
};

export const verifyState = (
  signingKey: string,
  state: string,
): SignedStatePayload | null => {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = fromB64url(encodedPayload);
    sig = fromB64url(encodedSig);
  } catch {
    return null;
  }
  const payload = payloadBytes.toString("utf8");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;

  const segments = payload.split(".");
  if (segments.length !== 2) return null;
  const [tenantId, nonce] = segments;
  if (!tenantId || !nonce) return null;
  return { tenantId, nonce };
};

// ------------------------------------------------------------
// Install-URL builder
// ------------------------------------------------------------

export interface InstallUrlOptions {
  readonly shop: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly redirectUri: string;
  readonly state: string;
  /** Optional. Defaults to "per-user=false" (offline access mode). */
  readonly grantOptions?: "per-user";
}

export const buildInstallUrl = (opts: InstallUrlOptions): string => {
  if (!isValidShopDomain(opts.shop)) {
    throw new Error(`invalid shop domain: ${opts.shop}`);
  }
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes.join(","),
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  if (opts.grantOptions !== undefined) {
    params.set("grant_options[]", opts.grantOptions);
  }
  return `https://${opts.shop}/admin/oauth/authorize?${params.toString()}`;
};

// ------------------------------------------------------------
// Callback HMAC verification (Shopify scheme)
// ------------------------------------------------------------
//
// Shopify computes the callback `hmac` over the query string with the
// hmac+signature parameters removed and the rest sorted lexically. We
// reproduce that to compare against the value Shopify sent.

export const canonicalQueryForHmac = (
  query: Readonly<Record<string, string | ReadonlyArray<string>>>,
): string => {
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(query)) {
    if (k === "hmac" || k === "signature") continue;
    if (Array.isArray(v)) {
      for (const item of v) entries.push([k, String(item)]);
    } else {
      entries.push([k, String(v)]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .map(([k, v]) => `${encodeKv(k)}=${encodeKv(v)}`)
    .join("&");
};

// Shopify encodes `&`, `%`, `=` inside parameter values when computing the
// canonical query string for HMAC. Other characters are passed through —
// this is deliberately NOT `encodeURIComponent`, which over-encodes.
const encodeKv = (s: string): string =>
  s.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");

export interface VerifyCallbackHmacOptions {
  readonly clientSecret: string;
  readonly query: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly receivedHmac: string;
}

export const verifyCallbackHmac = (opts: VerifyCallbackHmacOptions): boolean => {
  const canonical = canonicalQueryForHmac(opts.query);
  const expected = computeHmac(opts.clientSecret, canonical);
  if (expected.length !== opts.receivedHmac.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(opts.receivedHmac, "hex"),
    );
  } catch {
    return false;
  }
};
