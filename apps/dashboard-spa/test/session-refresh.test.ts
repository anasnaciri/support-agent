import { describe, expect, it } from "vitest";

import {
  REFRESH_PATH,
  buildRefreshRedirect,
  sessionDisposition,
} from "../lib/session-refresh";

// U1: the middleware-less session read used to treat an expired access token
// as logged-out, destroying in-flight work. The sealed cookie also carries a
// WorkOS refreshToken, so an expired-but-refreshable session should be routed
// through the refresh route handler (RSCs can't Set-Cookie) instead of
// straight to /sign-up.
describe("sessionDisposition", () => {
  const now = 1_700_000_000_000;
  const nowSec = now / 1000;

  it("is logged_out when there is no sealed session", () => {
    expect(
      sessionDisposition({ hasSession: false, exp: undefined, hasRefreshToken: false, nowMs: now }),
    ).toBe("logged_out");
  });

  it("is active while the access token is unexpired", () => {
    expect(
      sessionDisposition({ hasSession: true, exp: nowSec + 60, hasRefreshToken: true, nowMs: now }),
    ).toBe("active");
  });

  it("is active when exp is absent (trust the cookie seal)", () => {
    expect(
      sessionDisposition({ hasSession: true, exp: undefined, hasRefreshToken: true, nowMs: now }),
    ).toBe("active");
  });

  it("is refreshable when expired and a refresh token is sealed in", () => {
    expect(
      sessionDisposition({ hasSession: true, exp: nowSec - 60, hasRefreshToken: true, nowMs: now }),
    ).toBe("refreshable");
  });

  it("is logged_out when expired with no refresh token to use", () => {
    expect(
      sessionDisposition({ hasSession: true, exp: nowSec - 60, hasRefreshToken: false, nowMs: now }),
    ).toBe("logged_out");
  });
});

describe("buildRefreshRedirect", () => {
  it("carries the current page as an encoded returnTo", () => {
    expect(buildRefreshRedirect("/tickets/abc")).toBe(
      `${REFRESH_PATH}?returnTo=%2Ftickets%2Fabc`,
    );
  });

  it("encodes a path with its own query string", () => {
    expect(buildRefreshRedirect("/tickets?status=open")).toBe(
      `${REFRESH_PATH}?returnTo=%2Ftickets%3Fstatus%3Dopen`,
    );
  });

  it("omits returnTo for the home page and missing paths", () => {
    expect(buildRefreshRedirect("/")).toBe(REFRESH_PATH);
    expect(buildRefreshRedirect(null)).toBe(REFRESH_PATH);
  });

  it("drops unsafe values (open-redirect guard)", () => {
    expect(buildRefreshRedirect("//evil.com")).toBe(REFRESH_PATH);
    expect(buildRefreshRedirect("https://evil.com")).toBe(REFRESH_PATH);
  });
});
