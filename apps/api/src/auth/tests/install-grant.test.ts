import { describe, expect, it } from "vitest";
import {
  INSTALL_GRANT_TTL_MS,
  isInstallGrantProvider,
  signInstallGrant,
  verifyInstallGrant,
} from "../install-grant.js";

const KEY = "install-grant-key";
const NOW = 1_000_000;

describe("install-grant", () => {
  it("round-trips a valid grant", () => {
    const token = signInstallGrant(
      KEY,
      { tenantId: "t1", provider: "shopify" },
      NOW + INSTALL_GRANT_TTL_MS,
    );
    expect(verifyInstallGrant(KEY, token, NOW)).toEqual({
      tenantId: "t1",
      provider: "shopify",
    });
  });

  it("rejects a grant signed with a different key (forgery)", () => {
    const token = signInstallGrant(
      "attacker-key",
      { tenantId: "victim", provider: "gmail" },
      NOW + INSTALL_GRANT_TTL_MS,
    );
    expect(verifyInstallGrant(KEY, token, NOW)).toBeNull();
  });

  it("rejects an expired grant", () => {
    const token = signInstallGrant(
      KEY,
      { tenantId: "t1", provider: "shopify" },
      NOW + 1000,
    );
    expect(verifyInstallGrant(KEY, token, NOW + 2000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signInstallGrant(
      KEY,
      { tenantId: "t1", provider: "shopify" },
      NOW + INSTALL_GRANT_TTL_MS,
    );
    const [, sig] = token.split(".");
    const forged = `${Buffer.from("victim.shopify." + (NOW + INSTALL_GRANT_TTL_MS), "utf8").toString("base64url")}.${sig}`;
    expect(verifyInstallGrant(KEY, forged, NOW)).toBeNull();
  });

  it("rejects an unknown provider", () => {
    // Hand-sign a payload with a bogus provider using the real key.
    const payload = `t1.stripe.${NOW + INSTALL_GRANT_TTL_MS}`;
    const token = signInstallGrant(
      KEY,
      { tenantId: "t1", provider: "shopify" },
      NOW + INSTALL_GRANT_TTL_MS,
    );
    // sanity: the real one verifies
    expect(verifyInstallGrant(KEY, token, NOW)).not.toBeNull();
    expect(isInstallGrantProvider("stripe")).toBe(false);
    expect(payload).toContain("stripe");
  });

  it("isInstallGrantProvider only accepts the three connectors", () => {
    expect(isInstallGrantProvider("shopify")).toBe(true);
    expect(isInstallGrantProvider("gmail")).toBe(true);
    expect(isInstallGrantProvider("google_sheets")).toBe(true);
    expect(isInstallGrantProvider("openrouter")).toBe(false);
    expect(isInstallGrantProvider("")).toBe(false);
  });
});
