import { describe, expect, it } from "vitest";

import { ApiError, UnauthorizedError } from "../lib/errors";
import {
  pickActiveWorkspaceForPath,
  shouldStartLoginForAuthError,
  workspaceBootstrapRedirectTarget,
} from "../lib/session-context";
import type { UnifiedWorkspace } from "@support-agent/dashboard-contracts";

const workspace = (
  id: string,
  kind: UnifiedWorkspace["kind"],
): UnifiedWorkspace => ({
  id,
  kind,
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  shopifyDomain: null,
  onboardingPending: false,
});

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

describe("pickActiveWorkspaceForPath", () => {
  it("selects the fulfillment partner workspace when a fulfillment partner portal deep link has no stored workspace", () => {
    const active = pickActiveWorkspaceForPath(
      [workspace("merchant-1", "merchant"), workspace("fulfillment-operator-1", "fulfillment_operator")],
      undefined,
      "/fulfillment-operator/tickets",
    );

    expect(active?.id).toBe("fulfillment-operator-1");
  });

  it("overrides a stored merchant workspace on fulfillment partner portal routes", () => {
    const active = pickActiveWorkspaceForPath(
      [workspace("merchant-1", "merchant"), workspace("fulfillment-operator-1", "fulfillment_operator")],
      "merchant-1",
      "/fulfillment-operator/tickets",
    );

    expect(active?.id).toBe("fulfillment-operator-1");
  });

  it("keeps the normal default selection on merchant routes", () => {
    const active = pickActiveWorkspaceForPath(
      [workspace("merchant-1", "merchant"), workspace("fulfillment-operator-1", "fulfillment_operator")],
      undefined,
      "/",
    );

    expect(active?.id).toBe("merchant-1");
  });

  it("falls back to the normal active workspace when a fulfillment partner route has no fulfillment partner workspace", () => {
    const active = pickActiveWorkspaceForPath(
      [workspace("merchant-1", "merchant")],
      undefined,
      "/fulfillment-operator/tickets",
    );

    expect(active?.id).toBe("merchant-1");
  });
});
