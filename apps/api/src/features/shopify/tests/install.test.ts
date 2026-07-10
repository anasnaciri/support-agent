import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { computeHmac } from "@support-agent/services";
import {
  buildInstallUrl,
  buildManagedInstallUrl,
  canonicalQueryForHmac,
  isValidShopDomain,
  isValidShopifyInstallLink,
  normalizeShopDomain,
  signState,
  verifyCallbackHmac,
  verifyState,
} from "../install.js";

describe("shopify-install — isValidShopDomain", () => {
  it("accepts lowercase myshopify.com subdomains", () => {
    expect(isValidShopDomain("acme.myshopify.com")).toBe(true);
    expect(isValidShopDomain("my-store-123.myshopify.com")).toBe(true);
  });

  it("rejects protocol, paths, uppercase, foreign tld, empty subdomain", () => {
    expect(isValidShopDomain("https://acme.myshopify.com")).toBe(false);
    expect(isValidShopDomain("acme.myshopify.com/")).toBe(false);
    expect(isValidShopDomain("Acme.myshopify.com")).toBe(false);
    expect(isValidShopDomain("acme.shopify.com")).toBe(false);
    expect(isValidShopDomain(".myshopify.com")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
  });
});

describe("shopify-install — normalizeShopDomain", () => {
  it("accepts bare domains and pasted Shopify URLs", () => {
    expect(normalizeShopDomain("support-agent-test.myshopify.com")).toBe(
      "support-agent-test.myshopify.com",
    );
    expect(normalizeShopDomain("https://support-agent-test.myshopify.com/")).toBe(
      "support-agent-test.myshopify.com",
    );
    expect(
      normalizeShopDomain("https://SUPPORT-AGENT-TEST.myshopify.com/admin"),
    ).toBe("support-agent-test.myshopify.com");
  });

  it("rejects non-Shopify hosts", () => {
    expect(normalizeShopDomain("https://example.com/")).toBeNull();
    expect(normalizeShopDomain("https://acme.myshopify.com.evil.test/")).toBeNull();
    expect(normalizeShopDomain("https://acme.shopify.com/")).toBeNull();
  });
});

describe("shopify-install — isValidShopifyInstallLink", () => {
  it("accepts an https admin.shopify.com custom-app install link", () => {
    expect(
      isValidShopifyInstallLink(
        "https://admin.shopify.com/store/acme/oauth/install_custom_app?client_id=abc&signature=xyz",
      ),
    ).toBe(true);
  });

  it("accepts an https *.myshopify.com install link", () => {
    expect(
      isValidShopifyInstallLink(
        "https://acme.myshopify.com/admin/oauth/install_custom_app?client_id=abc",
      ),
    ).toBe(true);
  });

  it("rejects non-https, non-Shopify hosts, look-alikes, and garbage", () => {
    expect(
      isValidShopifyInstallLink(
        "http://admin.shopify.com/store/acme/oauth/install_custom_app",
      ),
    ).toBe(false);
    expect(isValidShopifyInstallLink("https://evil.test/install")).toBe(false);
    // A look-alike host that merely contains the suffix mid-string must fail —
    // the leading dot guards the subdomain boundary (no open redirect).
    expect(
      isValidShopifyInstallLink("https://acme.myshopify.com.evil.test/install"),
    ).toBe(false);
    expect(isValidShopifyInstallLink("not-a-url")).toBe(false);
    expect(isValidShopifyInstallLink("")).toBe(false);
  });
});

describe("shopify-install — buildInstallUrl", () => {
  it("composes the expected Shopify authorize URL", () => {
    const url = buildInstallUrl({
      shop: "acme.myshopify.com",
      clientId: "abc123",
      redirectUri: "https://api.example.com/shopify/auth/callback",
      state: "state-token",
    });
    const u = new URL(url);
    expect(u.host).toBe("acme.myshopify.com");
    expect(u.pathname).toBe("/admin/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("abc123");
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/shopify/auth/callback",
    );
    expect(u.searchParams.get("state")).toBe("state-token");
  });

  it("throws on an invalid shop domain", () => {
    expect(() =>
      buildInstallUrl({
        shop: "not-a-shop",
        clientId: "x",
        redirectUri: "https://x",
        state: "s",
      }),
    ).toThrow(/invalid shop domain/);
  });
});

describe("shopify-install — buildManagedInstallUrl", () => {
  it("composes Shopify's central install URL", () => {
    const url = buildManagedInstallUrl({ clientId: "abc123" });
    const u = new URL(url);
    expect(u.origin).toBe("https://admin.shopify.com");
    expect(u.pathname).toBe("/oauth/install");
    expect(u.searchParams.get("client_id")).toBe("abc123");
  });
});

describe("shopify-install — signState / verifyState", () => {
  const key = "shhh-state-key";

  it("round-trips the tenantId", () => {
    const state = signState(key, "tenant-1");
    const decoded = verifyState(key, state);
    expect(decoded?.tenantId).toBe("tenant-1");
    expect(typeof decoded?.nonce).toBe("string");
    expect((decoded?.nonce ?? "").length).toBeGreaterThan(0);
  });

  it("fails verification with a different signing key", () => {
    const state = signState(key, "tenant-1");
    expect(verifyState("other-key", state)).toBeNull();
  });

  it("fails on tampered state", () => {
    // Pin the nonce: with a random one this asserted on whatever bits the
    // signature happened to land on. Tamper the FIRST character of the
    // signature, not the last — a 32-byte HMAC is 43 base64url chars, so the
    // final char holds 4 significant bits and 2 that decode to nothing.
    // Rewriting it can leave the signature bytes identical, and the test then
    // asserts that an untampered state fails to verify.
    const state = signState(key, "tenant-1", "fixed-nonce");
    expect(verifyState(key, state)).not.toBeNull();

    const dot = state.lastIndexOf(".");
    const head = state[dot + 1];
    const tampered =
      state.slice(0, dot + 1) + (head === "A" ? "B" : "A") + state.slice(dot + 2);
    expect(tampered).not.toBe(state);
    expect(verifyState(key, tampered)).toBeNull();
  });

  it("rejects non-canonical spellings of a valid state", () => {
    // Node's base64 decoder silently drops characters outside the alphabet, so
    // junk injected into either segment decodes away and the HMAC still checks
    // out. That makes a single valid state mintable into unlimited distinct raw
    // strings without the signing key — harmless until something dedups on the
    // raw string, at which point it is a replay bypass. Reject them at source.
    const state = signState(key, "tenant-1", "fixed-nonce");
    const dot = state.lastIndexOf(".");
    const payload = state.slice(0, dot);
    const sig = state.slice(dot + 1);

    const variants: ReadonlyArray<readonly [string, string]> = [
      ["junk in sig", `${payload}.${sig.slice(0, 5)}!${sig.slice(5)}`],
      ["junk in payload", `${payload.slice(0, 4)}***${payload.slice(4)}.${sig}`],
      ["padding on sig", `${payload}.${sig}==`],
      ["newline in sig", `${payload}.${sig.slice(0, 5)}\n${sig.slice(5)}`],
    ];

    for (const [label, variant] of variants) {
      expect(variant, label).not.toBe(state);
      expect(verifyState(key, variant), label).toBeNull();
    }
  });

  it("two calls with the same tenantId produce different state strings (random nonce)", () => {
    const a = signState(key, "tenant-1");
    const b = signState(key, "tenant-1");
    expect(a).not.toBe(b);
  });
});

describe("shopify-install — canonicalQueryForHmac", () => {
  it("sorts keys lexically and drops hmac/signature", () => {
    const out = canonicalQueryForHmac({
      shop: "acme.myshopify.com",
      code: "abc",
      timestamp: "1700000000",
      state: "s",
      hmac: "should-be-stripped",
      signature: "also-stripped",
    });
    expect(out).toBe(
      "code=abc&shop=acme.myshopify.com&state=s&timestamp=1700000000",
    );
  });

  it("encodes & % = in values", () => {
    const out = canonicalQueryForHmac({ a: "x&y=z%" });
    expect(out).toBe("a=x%26y%3Dz%25");
  });
});

describe("shopify-install — verifyCallbackHmac", () => {
  const clientSecret = "shopify-secret";

  it("accepts a signature Shopify itself would have produced", () => {
    const query = {
      shop: "acme.myshopify.com",
      code: "abc",
      timestamp: "1700000000",
      state: "s",
    };
    const canonical = canonicalQueryForHmac(query);
    const goodHmac = createHmac("sha256", clientSecret)
      .update(canonical)
      .digest("hex");
    expect(
      verifyCallbackHmac({
        clientSecret,
        query,
        receivedHmac: goodHmac,
      }),
    ).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const query = { shop: "acme.myshopify.com" };
    // Use an hmac of the SAME hex length so the constant-time compare
    // actually runs (instead of bailing on length mismatch). This keeps
    // the test honest about what verify does.
    const wrong = computeHmac("different-secret", "shop=acme.myshopify.com");
    expect(
      verifyCallbackHmac({
        clientSecret,
        query,
        receivedHmac: wrong,
      }),
    ).toBe(false);
  });
});
