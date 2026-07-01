// Pure org-provisioning decision for self-service onboarding. No
// `server-only` / authkit imports so it stays unit-testable; the onboarding
// action injects a real WorkOS-backed provisioner.
//
// Self-service signup creates a WorkOS *user* but no organization, so a
// brand-new merchant lands org-less. Onboarding calls this to give them
// their own org (named after their team) and add them as a member, so the
// rest of onboarding — which keys the tenant to a WorkOS org — can proceed.

export interface OrgProvisioner {
  /**
   * The org id of an existing active membership for this user, or null. Lets
   * provisioning stay idempotent across retries: if a prior attempt created
   * the org but failed before the session switched, we reuse it rather than
   * orphaning a second org.
   */
  readonly findExistingOrgId: (userId: string) => Promise<string | null>;
  /** Create a WorkOS organization, returning at least its id. */
  readonly createOrganization: (
    name: string,
  ) => Promise<{ readonly id: string }>;
  /** Add the user to the organization as a member. */
  readonly addMember: (
    organizationId: string,
    userId: string,
  ) => Promise<void>;
}

/**
 * Resolve the organization the tenant should be created under:
 *   1. the session's current org (invited user) — reuse;
 *   2. an existing membership (a retried signup) — reuse;
 *   3. otherwise create a fresh org named after their team + add the user.
 * `created` is true only in case 3 (the caller then switches the session).
 */
export const resolveOrganizationId = async (params: {
  readonly currentOrgId: string | null;
  readonly userId: string;
  readonly teamName: string;
  readonly provisioner: OrgProvisioner;
}): Promise<{ readonly organizationId: string; readonly created: boolean }> => {
  if (params.currentOrgId) {
    return { organizationId: params.currentOrgId, created: false };
  }
  const existing = await params.provisioner.findExistingOrgId(params.userId);
  if (existing) {
    return { organizationId: existing, created: false };
  }
  const org = await params.provisioner.createOrganization(params.teamName);
  await params.provisioner.addMember(org.id, params.userId);
  return { organizationId: org.id, created: true };
};
