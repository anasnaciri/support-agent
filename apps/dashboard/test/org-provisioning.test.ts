import { describe, expect, it, vi } from "vitest";
import {
  resolveOrganizationId,
  type OrgProvisioner,
} from "../lib/org-provisioning";

const stubProvisioner = (
  over: Partial<OrgProvisioner> = {},
): OrgProvisioner => ({
  findExistingOrgId: vi.fn(async () => null),
  createOrganization: vi.fn(async () => ({ id: "org_new" })),
  addMember: vi.fn(async () => undefined),
  ...over,
});

describe("resolveOrganizationId", () => {
  it("returns the session org without provisioning when already in one", async () => {
    const provisioner = stubProvisioner();

    const result = await resolveOrganizationId({
      currentOrgId: "org_existing",
      userId: "user_1",
      teamName: "Acme",
      provisioner,
    });

    expect(result).toEqual({ organizationId: "org_existing", created: false });
    expect(provisioner.findExistingOrgId).not.toHaveBeenCalled();
    expect(provisioner.createOrganization).not.toHaveBeenCalled();
    expect(provisioner.addMember).not.toHaveBeenCalled();
  });

  it("reuses an existing membership instead of creating a second org (retry-safe)", async () => {
    const provisioner = stubProvisioner({
      findExistingOrgId: vi.fn(async () => "org_from_prior_attempt"),
    });

    const result = await resolveOrganizationId({
      currentOrgId: null,
      userId: "user_42",
      teamName: "Acme Co",
      provisioner,
    });

    expect(result).toEqual({
      organizationId: "org_from_prior_attempt",
      created: false,
    });
    expect(provisioner.createOrganization).not.toHaveBeenCalled();
    expect(provisioner.addMember).not.toHaveBeenCalled();
  });

  it("creates an org and adds the user when org-less with no prior membership", async () => {
    const createOrganization = vi
      .fn<OrgProvisioner["createOrganization"]>()
      .mockResolvedValue({ id: "org_new" });
    const addMember = vi
      .fn<OrgProvisioner["addMember"]>()
      .mockResolvedValue(undefined);
    const provisioner = stubProvisioner({ createOrganization, addMember });

    const result = await resolveOrganizationId({
      currentOrgId: null,
      userId: "user_42",
      teamName: "Acme Co",
      provisioner,
    });

    expect(result).toEqual({ organizationId: "org_new", created: true });
    expect(createOrganization).toHaveBeenCalledWith("Acme Co");
    expect(addMember).toHaveBeenCalledWith("org_new", "user_42");
    // Order: create the org before adding the membership.
    expect(createOrganization.mock.invocationCallOrder[0]!).toBeLessThan(
      addMember.mock.invocationCallOrder[0]!,
    );
  });
});
