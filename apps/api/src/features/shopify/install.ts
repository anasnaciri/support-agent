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

export const normalizeShopDomain = (shop: string): string | null => {
  const trimmed = shop.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (trimmed.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
          ? trimmed
          : `https://${trimmed}`,
      );
      candidate = url.hostname;
    } catch {
      return null;
    }
  }

  const normalized = candidate.toLowerCase();
  return isValidShopDomain(normalized) ? normalized : null;
};

// ------------------------------------------------------------
// Operator-supplied store-unique install link (pilot)
// ------------------------------------------------------------
//
// For a custom-distribution app, the operator generates a store-unique
// install link in the Shopify dev/Partner dashboard and pastes it into the
// admin console. The merchant's Connect button then redirects straight to
// it (the link drives Shopify's own install flow, landing back on our OAuth
// callback) instead of us building the `/admin/oauth/authorize` URL.
//
// Because we redirect a browser to this operator-supplied value, validate it
// strictly: an absolute HTTPS URL on a Shopify host (`admin.shopify.com` or a
// `*.myshopify.com` store), so a bad/hostile value can't become an open
// redirect. Path + query are Shopify's to define, so they pass through.

export const isValidShopifyInstallLink = (link: string): boolean => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "admin.shopify.com" || host.endsWith(".myshopify.com");
};

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
  // Node's base64 decoder drops characters outside the alphabet instead of
  // rejecting them, so junk injected into either segment decodes away and the
  // HMAC below still passes. Require each segment to be the canonical encoding
  // of its own bytes, so one valid state cannot be respelled into unlimited
  // distinct raw strings.
  if (b64url(payloadBytes) !== encodedPayload) return null;
  if (b64url(sig) !== encodedSig) return null;

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
  readonly redirectUri: string;
  readonly state: string;
  /** Optional. Defaults to "per-user=false" (offline access mode). */
  readonly grantOptions?: "per-user";
}

/**
 * Build the OAuth authorize URL for the dashboard-initiated install
 * flow. Scopes are NOT passed as a query param — Shopify reads them
 * from the Partner Dashboard's "Required access scopes" config, which
 * is the single source of truth. Editing the dashboard config
 * auto-prompts existing merchants to update permissions on their next
 * install visit; no need to coordinate a re-install separately.
 */
export const buildInstallUrl = (opts: InstallUrlOptions): string => {
  const shop = normalizeShopDomain(opts.shop);
  if (!shop) {
    throw new Error(`invalid shop domain: ${opts.shop}`);
  }
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  if (opts.grantOptions !== undefined) {
    params.set("grant_options[]", opts.grantOptions);
  }
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
};

export interface ManagedInstallUrlOptions {
  readonly clientId: string;
}

export const buildManagedInstallUrl = (
  opts: ManagedInstallUrlOptions,
): string => {
  const params = new URLSearchParams({
    client_id: opts.clientId,
  });
  return `https://admin.shopify.com/oauth/install?${params.toString()}`;
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
