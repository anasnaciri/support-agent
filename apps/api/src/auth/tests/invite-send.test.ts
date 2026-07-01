import { describe, expect, it } from "vitest";

import { resolveInvitationId } from "../invite-send.js";
import type { WorkosOrgAdminDirectory } from "../workos-directory.js";

// The api decides which WorkOS invitation id to persist for a member/supplier
// invite: a caller-minted one (the Next dashboard sends WorkOS's id from its
// server action) is used as-is, otherwise the api sends the invitation itself
// (the Vite SPA has no WORKOS_API_KEY). A missing admin directory or a failed
// send falls back to undefined — the invitation is still stored and reconciles
// on the invitee's verified email; only the WorkOS email is skipped.
const recordingDir = () => {
  const calls: Array<{
    email: string;
    organizationId: string;
    inviterUserId?: string;
  }> = [];
  const dir: WorkosOrgAdminDirectory = {
    createOrganization: async () => ({ id: "org_x" }),
    addOrganizationMembership: async () => true,
    listOrganizationMemberships: async () => [],
    sendInvitation: async (i) => {
      calls.push(i);
      return { id: `srv_${i.email}` };
    },
  };
  return { dir, calls };
};

describe("resolveInvitationId", () => {
  it("uses a caller-provided id as-is and never calls WorkOS (Next path)", async () => {
    const { dir, calls } = recordingDir();
    const id = await resolveInvitationId({
      provided: "invitation_client",
      adminDir: dir,
      email: "sam@acme.com",
      organizationId: "org_1",
      inviterUserId: "user_boss",
    });
    expect(id).toBe("invitation_client");
    expect(calls).toHaveLength(0);
  });

  it("sends server-side when no id is provided and returns the WorkOS id (SPA path)", async () => {
    const { dir, calls } = recordingDir();
    const id = await resolveInvitationId({
      provided: undefined,
      adminDir: dir,
      email: "sam@acme.com",
      organizationId: "org_1",
      inviterUserId: "user_boss",
    });
    expect(id).toBe("srv_sam@acme.com");
    expect(calls).toEqual([
      { email: "sam@acme.com", organizationId: "org_1", inviterUserId: "user_boss" },
    ]);
  });

  it("returns undefined when there is no admin directory (WORKOS_API_KEY unset)", async () => {
    const id = await resolveInvitationId({
      provided: undefined,
      adminDir: null,
      email: "sam@acme.com",
      organizationId: "org_1",
    });
    expect(id).toBeUndefined();
  });

  it("falls back to undefined when the WorkOS send fails (soft-fail)", async () => {
    const failing: WorkosOrgAdminDirectory = {
      createOrganization: async () => null,
      addOrganizationMembership: async () => false,
      listOrganizationMemberships: async () => [],
      sendInvitation: async () => null,
    };
    const id = await resolveInvitationId({
      provided: undefined,
      adminDir: failing,
      email: "sam@acme.com",
      organizationId: "org_1",
    });
    expect(id).toBeUndefined();
  });
});
