import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";

import { getDashboardContext } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { ImapConnectForm } from "./_connect-form";

export default async function ConnectImapPage() {
  // Auth-gates the page: resolves the tenant from the WorkOS session and
  // redirects to sign-up when logged out. Validation/connectivity errors are
  // rendered inline by the useActionState form (U4) — no error query params.
  await getDashboardContext();

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/settings/integrations">
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to integrations
        </Link>
      </Button>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Connect a mailbox (IMAP / SMTP)
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For any provider without a dedicated connector — PrivateEmail, Zoho,
          Fastmail, cPanel, or a custom domain. Enter the address and an{" "}
          <strong>app password</strong>; we detect the server settings
          automatically and verify the login before saving. The password is
          stored encrypted.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="size-4" aria-hidden />
            Mailbox credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ImapConnectForm />
        </CardContent>
      </Card>
    </div>
  );
}
