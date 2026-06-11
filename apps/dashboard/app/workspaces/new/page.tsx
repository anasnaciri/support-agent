import { getDashboardContext } from "@/lib/api-client";
import { getSession } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { NewWorkspaceForm } from "./NewWorkspaceForm";

export default async function NewWorkspacePage() {
  // Requires an onboarded org (first workspace exists); onboarding owns the
  // zero-workspace case and getDashboardContext redirects there.
  await getDashboardContext();
  const { user } = await getSession();

  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">New workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A workspace runs one store end to end: its own Shopify connection,
            support mailbox, AI provider key, cases, knowledge base, and
            policies. Everyone in your team can switch between workspaces from
            the sidebar.
          </p>
          <p className="text-sm text-muted-foreground">
            You&apos;ll be switched into the new workspace — connect its store
            and mailbox from{" "}
            <span className="font-medium text-foreground">
              Settings → Integrations
            </span>
            .
          </p>
          <NewWorkspaceForm defaultEmail={user?.email ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}
