import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SearchParams {
  readonly searchParams: Promise<{
    readonly reason?: string;
  }>;
}

const messageFor = (reason: string | undefined): string => {
  switch (reason) {
    case "no_organization":
      return "Your account isn't linked to a team. Ask your administrator to invite you to their support-agent organization.";
    case "no_tenant_mapping":
      return "Your team doesn't have a support-agent tenant configured yet. Contact support to finish onboarding.";
    default:
      return "You don't have access to this dashboard.";
  }
};

export default async function NoAccessPage({ searchParams }: SearchParams) {
  const { reason } = await searchParams;
  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">No access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{messageFor(reason)}</p>
          <p className="text-sm text-muted-foreground">
            If you think this is a mistake, double-check that you signed in
            with the email tied to your team.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
