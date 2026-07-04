import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  csrfRejected,
  isAllowedOrigin,
} from "../dashboard-session.js";

const allowed = new Set(["https://app-spa.example.com"]);
const withCookie = `${SESSION_COOKIE_NAME}=sealed; other=1`;

const base = {
  url: "/dashboard/tickets/x/resolve",
  method: "POST",
  cookieHeader: withCookie,
  authorizationHeader: undefined as string | undefined,
  origin: "https://app-spa.example.com",
  allowedOrigins: allowed,
};

describe("isAllowedOrigin", () => {
  it("matches exact allowlisted origins only", () => {
    expect(isAllowedOrigin("https://app-spa.example.com", allowed)).toBe(true);
    expect(isAllowedOrigin("https://evil.com", allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
});

describe("csrfRejected", () => {
  it("allows a cookie-authed mutation from an allowed origin", () => {
    expect(csrfRejected(base)).toBe(false);
  });

  it("rejects a cookie-authed mutation with no / disallowed origin", () => {
    expect(csrfRejected({ ...base, origin: undefined })).toBe(true);
    expect(csrfRejected({ ...base, origin: "https://evil.com" })).toBe(true);
  });

  it("ignores non-/dashboard routes", () => {
    expect(csrfRejected({ ...base, url: "/shopify/webhook", origin: undefined })).toBe(
      false,
    );
  });

  it("ignores safe methods (GET/OPTIONS incl. the OAuth callback + preflight)", () => {
    expect(csrfRejected({ ...base, method: "GET", origin: undefined })).toBe(false);
    expect(csrfRejected({ ...base, method: "OPTIONS", origin: undefined })).toBe(
      false,
    );
  });

  it("ignores the Bearer (Next dashboard) path — no ambient cookie vector", () => {
    expect(
      csrfRejected({
        ...base,
        authorizationHeader: "Bearer dash|org|user",
        origin: undefined,
      }),
    ).toBe(false);
  });

  it("ignores requests that carry no session cookie", () => {
    expect(csrfRejected({ ...base, cookieHeader: undefined, origin: undefined })).toBe(
      false,
    );
  });
});
