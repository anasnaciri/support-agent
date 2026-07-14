import { describe, expect, it } from "vitest";

import type { WorkspacesResponse } from "@support-agent/dashboard-contracts";
import type { Whoami } from "../lib/auth/session-api";
import { onboardingDisposition } from "../lib/onboarding-gate";

const user = {
  id: "user_1",
  email: "a@example.com",
  firstName: "Ada",
  lastName: null,
};

const authSession: Whoami = {
  organizationId: "org_1",
  userId: "decision_1",
  user,
};

const needsOnboarding: Whoami = {
  needsOnboarding: true,
  userId: "decision_1",
  user,
};

const workspaces = (
  rows: WorkspacesResponse["workspaces"],
): WorkspacesResponse => ({
  workspaces: rows,
  defaultWorkspaceId: rows[0]?.id ?? null,
});

describe("onboardingDisposition", () => {
  it("shows the form for a genuinely org-less user", () => {
    expect(onboardingDisposition(needsOnboarding, null)).toBe("show_form");
  });

  it("shows the form for an org that has no workspaces yet", () => {
    expect(onboardingDisposition(authSession, workspaces([]))).toBe("show_form");
  });

  it("redirects home when a misrouted user already has a workspace", () => {
    expect(
      onboardingDisposition(
        authSession,
        workspaces([
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Acme",
            createdAt: "2026-01-01T00:00:00.000Z",
            shopifyDomain: null,
            onboardingPending: false,
          },
        ]),
      ),
    ).toBe("redirect_home");
  });
});
