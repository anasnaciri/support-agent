import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PATH,
  SIGN_UP_PATH,
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
