import { redirect } from "next/navigation";

import { requireOrganization } from "@/lib/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { OnboardingForm } from "./OnboardingForm";

export default async function OnboardingPage() {
  const org = await requireOrganization();
  if (org.existingTenantId) {
    redirect("/");
  }

  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">
            Welcome — let&apos;s set up your team
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            You&apos;re signed in as{" "}
            <span className="font-medium text-foreground">{org.email}</span>{" "}
            under WorkOS organization{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {org.organizationId}
            </code>
            , but your team doesn&apos;t have a support-agent tenant yet.
          </p>
          <p className="text-sm text-muted-foreground">
            Fill this in once and you&apos;ll be sent to the dashboard. You can
            connect Shopify and Gmail from{" "}
            <span className="font-medium text-foreground">
              Settings → Integrations
            </span>{" "}
            once the tenant exists.
          </p>
          <OnboardingForm defaultEmail={org.email} />
        </CardContent>
      </Card>
    </div>
  );
}
