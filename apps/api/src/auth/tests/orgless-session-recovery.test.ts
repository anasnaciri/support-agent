import { describe, expect, it } from "vitest";

import { recoverOrglessSession } from "../dashboard-auth-routes.js";
import type { WorkosOrgAdminDirectory } from "../workos-directory.js";

const admin = (
  memberships: ReadonlyArray<string> | null,
): WorkosOrgAdminDirectory => ({
  createOrganization: async () => ({ id: "unused" }),
  addOrganizationMembership: async () => true,
  listOrganizationMemberships: async () => memberships,
  sendInvitation: async () => ({ id: "unused" }),
});

const workosFetch = (async (_url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as {
    organization_id?: string;
  };
  return new Response(
    JSON.stringify({
      access_token: `dash|${body.organization_id ?? ""}|user_a`,
      refresh_token: "rt_2",
      organization_id: body.organization_id ?? null,
      user: {
        id: "user_a",
        email: "a@example.com",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

describe("recoverOrglessSession", () => {
  it("re-mints an org-less session into an existing WorkOS membership", async () => {
    const result = await recoverOrglessSession({
      admin: admin(["org_existing"]),
      clientId: "client_test",
      apiKey: "sk_test",
      refreshToken: "rt_1",
      workosUserId: "user_a",
      fetchImpl: workosFetch,
    });

    expect(result.kind).toBe("recovered");
    if (result.kind === "recovered") {
      expect(result.organizationId).toBe("org_existing");
      expect(result.session.accessToken).toBe("dash|org_existing|user_a");
    }
  });

  it("keeps the onboarding path for a user with no memberships", async () => {
    const result = await recoverOrglessSession({
      admin: admin([]),
      clientId: "client_test",
      apiKey: "sk_test",
      refreshToken: "rt_1",
      workosUserId: "user_a",
      fetchImpl: workosFetch,
    });

    expect(result).toEqual({ kind: "needs_onboarding" });
  });

  it("does not treat a membership lookup failure as onboarding", async () => {
    const result = await recoverOrglessSession({
      admin: admin(null),
      clientId: "client_test",
      apiKey: "sk_test",
      refreshToken: "rt_1",
      workosUserId: "user_a",
      fetchImpl: workosFetch,
    });

    expect(result).toEqual({ kind: "lookup_failed" });
  });
});
