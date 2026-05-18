import { redirect } from "next/navigation";
import { requireOrganization } from "@/lib/tenant";
import { OnboardingForm } from "./OnboardingForm";

// Self-service onboarding for a WorkOS org that has no tenant yet.
// `getTenantId()` redirects to this route when it sees an org with no
// matching `tenants.workos_organization_id` row, replacing the manual
// `UPDATE tenants SET workos_organization_id = 'org_...'` step.

export default async function OnboardingPage() {
  const org = await requireOrganization();
  if (org.existingTenantId) {
    // The org is already onboarded — getTenantId() would have returned
    // a tenant on any other route. Bounce home so this page never
    // surfaces stale state.
    redirect("/");
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: "60px auto" }}>
      <h1>Welcome — let's set up your team</h1>
      <p className="muted">
        You're signed in as <strong>{org.email}</strong> under WorkOS
        organization <code>{org.organizationId}</code>, but your team
        doesn't have a support-agent tenant yet.
      </p>
      <p className="muted">
        Fill this in once and you'll be sent to the dashboard. You can
        connect Shopify and Gmail from <code>Settings → Integrations</code>{" "}
        once the tenant exists.
      </p>
      <OnboardingForm defaultEmail={org.email} />
    </div>
  );
}
