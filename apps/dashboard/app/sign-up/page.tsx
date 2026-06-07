import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { dataProcessingNoticeUrl } from "@/lib/legal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { SignUpForm } from "./SignUpForm";

// Self-hosted sign-up. The legal checkbox lives here (WorkOS's hosted UI can't
// enforce it); ticking it gates the Google handoff. Already-signed-in users
// have no business here — send them to onboarding/dashboard.
export default async function SignUpPage() {
  const { user } = await getSession();
  if (user) {
    redirect("/onboarding");
  }
  const legalUrl = dataProcessingNoticeUrl();

  return (
    <div className="mx-auto mt-12 max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Create your account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Accept the data processing terms, then continue with Google to set
            up your support-agent team.
          </p>
          <SignUpForm legalUrl={legalUrl} />
        </CardContent>
      </Card>
    </div>
  );
}
