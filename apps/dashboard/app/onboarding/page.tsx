import { redirect } from "next/navigation";

import { requireOrganization } from "@/lib/api-client";
import { dataProcessingNoticeUrl } from "@/lib/legal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { OnboardingForm } from "./OnboardingForm";

export default async function OnboardingPage() {
  const org = await requireOrganization();
  if (org.existingTenantId) {
    redirect("/");
  }
  const legalUrl = dataProcessingNoticeUrl();

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
            <span className="font-medium text-foreground">{org.email}</span>.{" "}
            {org.organizationId ? (
              <>
                Your team doesn&apos;t have a support-agent tenant yet — name it
                below to get started.
              </>
            ) : (
              <>
                Name your team below and we&apos;ll set up your workspace.
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            Fill this in once and you&apos;ll be sent to the dashboard. You can
            connect Shopify and Gmail from{" "}
            <span className="font-medium text-foreground">
              Settings → Integrations
            </span>{" "}
            once the tenant exists.
          </p>
          <OnboardingForm
            defaultEmail={org.email}
            legalUrl={legalUrl}
            alreadyAcceptedAt={org.legalAcceptedAt}
          />
        </CardContent>
      </Card>
    </div>
  );
}
