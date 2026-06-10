import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";

import { getDashboardContext } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

import { connectImapAction } from "./actions";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function ConnectImapPage({ searchParams }: PageProps) {
  // Auth-gates the page: resolves the tenant from the WorkOS session and
  // redirects to sign-up when logged out.
  await getDashboardContext();
  const params = (await searchParams) ?? {};
  const error = first(params["error"]);
  const detail = first(params["detail"]);

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
          Fastmail, cPanel, or a custom domain. Use an{" "}
          <strong>app password</strong> if your provider offers one. We verify
          the login against both servers before saving; the password is stored
          encrypted.
        </p>
      </div>

      {error === "missing_fields" ? (
        <Alert variant="warning">
          <AlertDescription>
            Mailbox, password, and both server hosts are required.
          </AlertDescription>
        </Alert>
      ) : null}
      {error === "imap_connect_failed" ? (
        <Alert variant="warning">
          <AlertTitle>Couldn&apos;t connect</AlertTitle>
          <AlertDescription>
            We couldn&apos;t log in to IMAP or SMTP with those details. Check the
            host, port, and app password.
            {detail ? (
              <span className="mt-1 block font-mono text-xs opacity-80">
                {detail}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {error === "legal_acceptance_required" ? (
        <Alert variant="warning">
          <AlertDescription>
            Accept the current data processing notice in{" "}
            <Link
              href="/settings/legal"
              className="font-medium text-primary hover:underline"
            >
              Settings → Legal
            </Link>{" "}
            before connecting a mailbox.
          </AlertDescription>
        </Alert>
      ) : null}
      {error === "unexpected" ? (
        <Alert variant="warning">
          <AlertDescription>
            Something went wrong saving the connection. Please try again.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="size-4" aria-hidden />
            Mailbox credentials
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <form action={connectImapAction} className="space-y-5">
            <div className="grid gap-2">
              <Label htmlFor="mailbox">Email address</Label>
              <Input
                id="mailbox"
                name="mailbox"
                type="email"
                autoComplete="off"
                placeholder="support@yourdomain.com"
                required
              />
              <p className="text-xs text-muted-foreground">
                The address customers email. Replies are sent from here.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">App password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="off"
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="user">
                Login username{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="user"
                name="user"
                autoComplete="off"
                placeholder="Defaults to the email address"
              />
            </div>

            <fieldset className="grid gap-3 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">
                Incoming (IMAP)
              </legend>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="imapHost">Host</Label>
                  <Input
                    id="imapHost"
                    name="imapHost"
                    placeholder="imap.yourprovider.com"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="imapPort">Port</Label>
                  <Input
                    id="imapPort"
                    name="imapPort"
                    type="number"
                    defaultValue={993}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="imapSecure">Security</Label>
                <NativeSelect id="imapSecure" name="imapSecure" defaultValue="true">
                  <option value="true">TLS / SSL (port 993)</option>
                  <option value="false">None / STARTTLS (port 143)</option>
                </NativeSelect>
              </div>
            </fieldset>

            <fieldset className="grid gap-3 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">
                Outgoing (SMTP)
              </legend>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="smtpHost">Host</Label>
                  <Input
                    id="smtpHost"
                    name="smtpHost"
                    placeholder="smtp.yourprovider.com"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="smtpPort">Port</Label>
                  <Input
                    id="smtpPort"
                    name="smtpPort"
                    type="number"
                    defaultValue={465}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="smtpSecure">Security</Label>
                <NativeSelect id="smtpSecure" name="smtpSecure" defaultValue="true">
                  <option value="true">TLS / SSL (port 465)</option>
                  <option value="false">STARTTLS / none (port 587)</option>
                </NativeSelect>
              </div>
            </fieldset>

            <Button type="submit">Verify &amp; connect</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
