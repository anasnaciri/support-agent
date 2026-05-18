import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeHmac,
  verifyShopifyWebhookHmac,
  verifySignedRequest,
  verifyWebhookSignature,
} from "../src/hmac.js";

const secret = "test-secret";
const body = '{"id":"evt_123","type":"order.created"}';

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const sig = computeHmac(secret, body);
    expect(verifyWebhookSignature({ secret, body, signature: sig })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = computeHmac(secret, body);
    const tampered = body.replace("order.created", "order.refunded");
    expect(
      verifyWebhookSignature({ secret, body: tampered, signature: sig }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = computeHmac("other-secret", body);
    expect(verifyWebhookSignature({ secret, body, signature: sig })).toBe(
      false,
    );
  });

  it("rejects a malformed signature", () => {
    expect(
      verifyWebhookSignature({ secret, body, signature: "not-hex!!" }),
    ).toBe(false);
  });

  it("works with Buffer bodies", () => {
    const buf = Buffer.from(body, "utf8");
    const sig = computeHmac(secret, buf);
    expect(verifyWebhookSignature({ secret, body: buf, signature: sig })).toBe(
      true,
    );
  });

  it("supports sha512", () => {
    const sig = computeHmac(secret, body, "sha512");
    expect(
      verifyWebhookSignature({
        secret,
        body,
        signature: sig,
        algorithm: "sha512",
      }),
    ).toBe(true);
  });
});

describe("verifyShopifyWebhookHmac", () => {
  const clientSecret = "shpss_fake_secret";
  const payload = Buffer.from(
    '{"id":1,"name":"acme.myshopify.com","domain":"acme.com"}',
    "utf8",
  );
  const goodB64 = createHmac("sha256", clientSecret)
    .update(payload)
    .digest("base64");

  it("accepts a valid base64 signature over the raw bytes", () => {
    expect(
      verifyShopifyWebhookHmac({
        clientSecret,
        rawBody: payload,
        receivedHmacB64: goodB64,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.concat([payload, Buffer.from(" ", "utf8")]);
    expect(
      verifyShopifyWebhookHmac({
        clientSecret,
        rawBody: tampered,
        receivedHmacB64: goodB64,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(
      verifyShopifyWebhookHmac({
        clientSecret: "wrong",
        rawBody: payload,
        receivedHmacB64: goodB64,
      }),
    ).toBe(false);
  });

  it("rejects a hex-encoded signature (must be base64)", () => {
    const hex = createHmac("sha256", clientSecret)
      .update(payload)
      .digest("hex");
    expect(
      verifyShopifyWebhookHmac({
        clientSecret,
        rawBody: payload,
        receivedHmacB64: hex,
      }),
    ).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(
      verifyShopifyWebhookHmac({
        clientSecret,
        rawBody: payload,
        receivedHmacB64: "",
      }),
    ).toBe(false);
  });
});

describe("verifySignedRequest (timestamp + signature, replay-resistant)", () => {
  const fixedNow = 1_715_000_000;
  const sign = (ts: number) =>
    computeHmac(secret, `${ts}.${body}`);

  it("accepts a fresh request", () => {
    const result = verifySignedRequest({
      secret,
      body,
      signature: sign(fixedNow),
      timestamp: fixedNow,
      nowSeconds: fixedNow,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a request older than tolerance", () => {
    const result = verifySignedRequest({
      secret,
      body,
      signature: sign(fixedNow - 1000),
      timestamp: fixedNow - 1000,
      nowSeconds: fixedNow,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a future timestamp outside tolerance", () => {
    const result = verifySignedRequest({
      secret,
      body,
      signature: sign(fixedNow + 1000),
      timestamp: fixedNow + 1000,
      nowSeconds: fixedNow,
      toleranceSeconds: 300,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a request where the signature does not bind to the timestamp", () => {
    const sigForDifferentTimestamp = sign(fixedNow - 10);
    const result = verifySignedRequest({
      secret,
      body,
      signature: sigForDifferentTimestamp,
      timestamp: fixedNow,
      nowSeconds: fixedNow,
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
