import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PATH,
  SIGN_UP_PATH,
  buildSignUpRedirect,
  resolveDashboardRedirect,
} from "../lib/auth-redirect";

// Regression test for the auth-gate routing (audit B2 / re-audit #4): a
// logged-out visitor must be sent to the legal-gated /sign-up, NOT the
// WorkOS-hosted /sign-in, so the data-processing checkbox can't be skipped.
describe("resolveDashboardRedirect", () => {
  it("sends a logged-out request to /sign-up (never /sign-in)", () => {
    const target = resolveDashboardRedirect({
      hasUser: false,
      hasOrganization: false,
      hasTenant: false,
    });
    expect(target).toBe(SIGN_UP_PATH);
    expect(target).toBe("/sign-up");
    expect(target).not.toBe("/sign-in");
  });

  it("sends a signed-in user with no organization to onboarding", () => {
    expect(
      resolveDashboardRedirect({
        hasUser: true,
        hasOrganization: false,
        hasTenant: false,
      }),
    ).toBe(ONBOARDING_PATH);
  });

  it("sends a signed-in user whose org has no tenant to onboarding", () => {
    expect(
      resolveDashboardRedirect({
        hasUser: true,
        hasOrganization: true,
        hasTenant: false,
      }),
    ).toBe(ONBOARDING_PATH);
  });

  it("proceeds (null) for a fully provisioned user", () => {
    expect(
      resolveDashboardRedirect({
        hasUser: true,
        hasOrganization: true,
        hasTenant: true,
      }),
    ).toBeNull();
  });
});

// The logged-out redirect carries the page the user was on as a `returnTo`
// query param so re-auth can land them back there. The destination stays the
// legal-gated /sign-up; only the query is added.
describe("buildSignUpRedirect", () => {
  it("appends an encoded returnTo for a real page", () => {
    expect(buildSignUpRedirect("/cases/abc")).toBe(
      `${SIGN_UP_PATH}?returnTo=%2Fcases%2Fabc`,
    );
  });

  it("encodes a path that carries its own query string", () => {
    expect(buildSignUpRedirect("/cases?status=open")).toBe(
      `${SIGN_UP_PATH}?returnTo=%2Fcases%3Fstatus%3Dopen`,
    );
  });

  it("omits the query for the home page (nothing to preserve)", () => {
    expect(buildSignUpRedirect("/")).toBe(SIGN_UP_PATH);
  });

  it("omits the query for a missing path", () => {
    expect(buildSignUpRedirect(null)).toBe(SIGN_UP_PATH);
    expect(buildSignUpRedirect(undefined)).toBe(SIGN_UP_PATH);
  });

  it("drops an unsafe returnTo rather than preserving it", () => {
    expect(buildSignUpRedirect("//evil.com")).toBe(SIGN_UP_PATH);
    expect(buildSignUpRedirect("https://evil.com")).toBe(SIGN_UP_PATH);
  });
});
