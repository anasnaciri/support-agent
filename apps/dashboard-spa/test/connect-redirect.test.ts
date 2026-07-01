import { describe, expect, it } from "vitest";

import { connectRedirectUrl } from "../lib/connect-redirect";

// The OAuth `login_hint` prefill was removed for EVERY connector (2026-06-10):
// the dashboard login email (WorkOS) is the merchant's account, which is almost
// never the support mailbox they want to connect. Passing it as `login_hint`
// made Microsoft pre-select / lock onto the wrong account on the consent screen,
// blocking the merchant from choosing their mailbox. No connector should
// prefill the account — the user always picks it on the provider's screen.
describe("connectRedirectUrl", () => {
  const base = "https://api.example.com/microsoft/install?grant=abc";

  it("does NOT append login_hint for outlook", () => {
    expect(connectRedirectUrl(base, "outlook", "owner@store.com")).toBe(base);
  });

  it("does NOT append login_hint for gmail", () => {
    expect(connectRedirectUrl(base, "gmail", "owner@store.com")).toBe(base);
  });

  it("does NOT append login_hint for google_sheets", () => {
    expect(connectRedirectUrl(base, "google_sheets", "owner@store.com")).toBe(
      base,
    );
  });

  it("does NOT append login_hint for shopify", () => {
    expect(connectRedirectUrl(base, "shopify", "owner@store.com")).toBe(base);
  });

  it("returns the url unchanged when no email is present", () => {
    expect(connectRedirectUrl(base, "outlook", null)).toBe(base);
    expect(connectRedirectUrl(base, "outlook", undefined)).toBe(base);
  });
});
