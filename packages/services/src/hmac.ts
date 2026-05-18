import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacAlgorithm = "sha256" | "sha512";

export interface VerifyWebhookSignatureOptions {
  readonly secret: string;
  readonly body: string | Buffer;
  readonly signature: string;
  readonly algorithm?: HmacAlgorithm;
}

export interface VerifySignedRequestOptions
  extends VerifyWebhookSignatureOptions {
  readonly timestamp: number;
  readonly nowSeconds?: number;
  readonly toleranceSeconds?: number;
}

export type SignedRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "expired" | "invalid" };

export const computeHmac = (
  secret: string,
  body: string | Buffer,
  algorithm: HmacAlgorithm = "sha256",
): string => createHmac(algorithm, secret).update(body).digest("hex");

const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};

export const verifyWebhookSignature = (
  opts: VerifyWebhookSignatureOptions,
): boolean => {
  const expected = computeHmac(opts.secret, opts.body, opts.algorithm);
  return timingSafeEqualHex(expected, opts.signature);
};

/**
 * Verify a Shopify webhook HMAC.
 *
 * Shopify signs webhooks with HMAC-SHA256 over the RAW request body bytes
 * using the app's `client_secret` (NOT a separate webhook secret) and ships
 * the result as **base64** in the `X-Shopify-Hmac-Sha256` header.
 *
 * This is a different scheme from:
 *   - `verifyWebhookSignature` — expects hex
 *   - the OAuth callback HMAC — computed over a canonical query string
 *
 * The body MUST be the unmodified raw bytes. Re-encoding through JSON.parse
 * + JSON.stringify will change byte order / whitespace and the HMAC won't
 * verify.
 */
export const verifyShopifyWebhookHmac = (opts: {
  readonly clientSecret: string;
  readonly rawBody: Buffer;
  readonly receivedHmacB64: string;
}): boolean => {
  const expected = createHmac("sha256", opts.clientSecret)
    .update(opts.rawBody)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(opts.receivedHmacB64, "base64");
  } catch {
    return false;
  }
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
};

export const verifySignedRequest = (
  opts: VerifySignedRequestOptions,
): SignedRequestResult => {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - opts.timestamp) > tolerance) {
    return { ok: false, reason: "expired" };
  }
  const payload = `${opts.timestamp}.${
    typeof opts.body === "string" ? opts.body : opts.body.toString("utf8")
  }`;
  const expected = computeHmac(opts.secret, payload, opts.algorithm);
  if (!timingSafeEqualHex(expected, opts.signature)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
};
