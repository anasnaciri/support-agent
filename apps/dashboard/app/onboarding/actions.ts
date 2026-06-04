"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getWorkOS, switchToOrganization } from "@workos-inc/authkit-nextjs";
import { api, requireOrganization } from "@/lib/api-client";
import { resolveOrganizationId } from "@/lib/org-provisioning";

// Self-service onboarding for a signed-in user. A brand-new signup has no
// WorkOS organization, so we create one (named after their team) and add
// them to it, then create the tenant under that org. An invited user
// already has an org — we reuse it. Idempotent by org: if the org already
// has a tenant, we redirect rather than double-creating (the partial unique
// index on `workos_organization_id` would reject anyway).
//
// The form fields populate `tenants.name` and `tenants.settings`. The
// shop domain is NOT required at this stage — Shopify install is a
// separate flow once the tenant exists. Same for connector setup.

interface FormShape {
  readonly name: string;
  readonly notificationEmail: string;
  readonly legalAccepted: boolean;
}

const readForm = (
  formData: FormData,
  // When the user already accepted at sign-up (WorkOS user metadata), the
  // onboarding form omits the checkbox and we don't require it here.
  legalAlreadyAccepted: boolean,
): FormShape | { readonly error: string } => {
  const nameRaw = formData.get("name");
  const emailRaw = formData.get("notificationEmail");
  const legalRaw = formData.get("legalAccepted");
  if (typeof nameRaw !== "string" || nameRaw.trim().length < 2) {
    return { error: "Team name is required (at least 2 characters)." };
  }
  if (typeof emailRaw !== "string" || !emailRaw.includes("@")) {
    return { error: "Notification email looks malformed." };
  }
  if (!legalAlreadyAccepted && legalRaw !== "on") {
    return {
      error:
        "Accept the data processing notice and Data Processing Addendum to continue.",
    };
  }
  return {
    name: nameRaw.trim().slice(0, 120),
    notificationEmail: emailRaw.trim().slice(0, 254),
    legalAccepted: true,
  };
};

export const createTenantAction = async (
  _prev: { readonly error?: string } | null,
  formData: FormData,
): Promise<{ readonly error?: string }> => {
  const org = await requireOrganization();
  // Already onboarded — bounce. The /onboarding page also short-
  // circuits, but a race (two tabs) can land us here.
  if (org.existingTenantId) {
    redirect("/");
  }

  const parsed = readForm(formData, org.legalAcceptedAt !== null);
  if ("error" in parsed) return parsed;

  // Provision the WorkOS org if the user doesn't have one yet (fresh
  // self-service signup); reuse it if they were invited into one or a prior
  // attempt already created one.
  const workos = getWorkOS();
  let resolved: { readonly organizationId: string; readonly created: boolean };
  try {
    resolved = await resolveOrganizationId({
      currentOrgId: org.organizationId,
      userId: org.userId,
      teamName: parsed.name,
      provisioner: {
        findExistingOrgId: async (userId) => {
          const memberships =
            await workos.userManagement.listOrganizationMemberships({
              userId,
              statuses: ["active"],
            });
          return memberships.data[0]?.organizationId ?? null;
        },
        createOrganization: (name) =>
          workos.organizations.createOrganization({ name }),
        addMember: (organizationId, userId) =>
          workos.userManagement
            .createOrganizationMembership({ organizationId, userId })
            .then(() => undefined),
      },
    });

    // If the session wasn't in an org, move it into the resolved one BEFORE
    // creating the tenant (no redirect — revalidationStrategy "none"). This
    // makes a retry after any later failure reuse this org via the switched
    // session / findExistingOrgId rather than orphaning a second one.
    if (!org.organizationId) {
      await switchToOrganization(resolved.organizationId, {
        revalidationStrategy: "none",
      });
    }
  } catch {
    return { error: "Could not create your team. Please try again." };
  }

  // Create the tenant for the resolved org (idempotent — a two-tab race
  // resolves to the existing tenant).
  const { status } = await api.onboarding(
    {
      organizationId: resolved.organizationId,
      userDecisionUuid: org.userDecisionUuid,
    },
    {
      name: parsed.name,
      notificationEmail: parsed.notificationEmail,
      legalAccepted: parsed.legalAccepted,
    },
  );
  if (status !== 200) {
    return { error: "Could not create tenant. Please try again." };
  }
  revalidatePath("/");
  redirect("/?onboarded=1");
};
