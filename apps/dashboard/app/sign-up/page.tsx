import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { dataProcessingNoticeUrl } from "@/lib/legal";
import { sanitizeReturnTo } from "@/lib/return-to";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { SignUpForm } from "./SignUpForm";

interface SignUpPageProps {
  readonly searchParams?: Promise<{ readonly returnTo?: string }>;
}

// Self-hosted sign-up. The legal checkbox lives here (WorkOS's hosted UI can't
// enforce it); ticking it gates the Google handoff. Already-signed-in users
// have no business here — send them to onboarding/dashboard.
//
// A `returnTo` query (set by the auth gate when a session lapses) is sanitised
// and handed to the form so re-auth lands the user back on the page they were
// on. A bare /sign-up (fresh user) has none; the flow then defaults to onboarding.
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const { user } = await getSession();
  if (user) {
    redirect("/onboarding");
  }
  const sp = searchParams ? await searchParams : {};
  const returnTo = sanitizeReturnTo(sp.returnTo, "");
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
          <SignUpForm legalUrl={legalUrl} returnTo={returnTo} />
        </CardContent>
      </Card>
    </div>
  );
}
