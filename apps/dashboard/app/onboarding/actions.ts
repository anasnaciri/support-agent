"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { tenants } from "@support-agent/db";
import { db } from "@/lib/db";
import { requireOrganization } from "@/lib/tenant";

// Self-service tenant creation for a signed-in WorkOS org. Idempotent
// by org: if the org already has a tenant, we redirect rather than
// double-creating (the partial unique index on `workos_organization_id`
// would reject anyway; this is a friendlier UX).
//
// The form fields populate `tenants.name` and `tenants.settings`. The
// shop domain is NOT required at this stage — Shopify install is a
// separate flow once the tenant exists. Same for connector setup.

interface FormShape {
  readonly name: string;
  readonly notificationEmail: string;
}

const readForm = (formData: FormData): FormShape | { readonly error: string } => {
  const nameRaw = formData.get("name");
  const emailRaw = formData.get("notificationEmail");
  if (typeof nameRaw !== "string" || nameRaw.trim().length < 2) {
    return { error: "Team name is required (at least 2 characters)." };
  }
  if (typeof emailRaw !== "string" || !emailRaw.includes("@")) {
    return { error: "Notification email looks malformed." };
  }
  return {
    name: nameRaw.trim().slice(0, 120),
    notificationEmail: emailRaw.trim().slice(0, 254),
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

  const parsed = readForm(formData);
  if ("error" in parsed) return parsed;

  const id = randomUUID();
  const d = db();
  try {
    await d.insert(tenants).values({
      id,
      name: parsed.name,
      workosOrganizationId: org.organizationId,
      settings: { notificationEmail: parsed.notificationEmail },
    });
  } catch (cause) {
    // Most likely the partial unique index on `workos_organization_id`
    // — another tab won the race. Treat as success: look up the row
    // and redirect home.
    const [existing] = await d
      .select({ id: tenants.id })
      .from(tenants)
      .where(
        and(
          eq(tenants.workosOrganizationId, org.organizationId),
        ),
      )
      .limit(1);
    if (!existing) {
      return {
        error:
          cause instanceof Error
            ? cause.message
            : "Could not create tenant. Please try again.",
      };
    }
  }
  revalidatePath("/");
  redirect("/?onboarded=1");
};
