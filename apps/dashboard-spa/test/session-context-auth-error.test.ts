import { describe, expect, it } from "vitest";

import { ApiError, UnauthorizedError } from "../lib/errors";
import {
  shouldStartLoginForAuthError,
  workspaceBootstrapRedirectTarget,
} from "../lib/session-context";

describe("shouldStartLoginForAuthError", () => {
  it("starts login only for a real unauthenticated session", () => {
    expect(shouldStartLoginForAuthError(new UnauthorizedError())).toBe(true);
  });

  it("does not log out the user for transient auth-session failures", () => {
    expect(shouldStartLoginForAuthError(new ApiError("temporary", 503))).toBe(
      false,
    );
    expect(shouldStartLoginForAuthError(new Error("network"))).toBe(false);
  });
});

describe("workspaceBootstrapRedirectTarget", () => {
  it("does not redirect while the merchant permission probe is still loading", () => {
    expect(
      workspaceBootstrapRedirectTarget({
        bootstrapReady: true,
        listsSettled: true,
        hasActiveWorkspace: false,
        merchantWorkspaceCount: 1,
        merchantProbeLoading: true,
      }),
    ).toBeNull();
  });

  it("sends a truly empty org to onboarding", () => {
    expect(
      workspaceBootstrapRedirectTarget({
        bootstrapReady: true,
        listsSettled: true,
        hasActiveWorkspace: false,
        merchantWorkspaceCount: 0,
        merchantProbeLoading: false,
      }),
    ).toBe("/onboarding");
  });

  it("sends an org member with no accessible workspace to no-access, not onboarding", () => {
    expect(
      workspaceBootstrapRedirectTarget({
        bootstrapReady: true,
        listsSettled: true,
        hasActiveWorkspace: false,
        merchantWorkspaceCount: 1,
        merchantProbeLoading: false,
      }),
    ).toBe("/no-access");
  });

  it("does not redirect once an accessible workspace exists", () => {
    expect(
      workspaceBootstrapRedirectTarget({
        bootstrapReady: true,
        listsSettled: true,
        hasActiveWorkspace: true,
        merchantWorkspaceCount: 1,
        merchantProbeLoading: false,
      }),
    ).toBeNull();
  });
});
