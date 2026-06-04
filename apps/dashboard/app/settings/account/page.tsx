import { TriangleAlert } from "lucide-react";

import { getDashboardContext } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { DeleteAccountForm } from "./_delete-account-form";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function AccountSettingsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const params = (await searchParams) ?? {};
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Delete account" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Delete account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently delete <span className="font-medium">{ctx.tenantName}</span>{" "}
          and everything tied to it.
        </p>
      </div>

      {errorRaw === "name_mismatch" ? (
        <Alert variant="warning">
          <AlertDescription>
            The name you typed didn&apos;t match. Nothing was deleted.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "delete_failed" ? (
        <Alert variant="destructive">
          <AlertDescription>
            We couldn&apos;t delete the account. Please try again, or contact
            support if this keeps happening.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="border-destructive/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <TriangleAlert className="size-4" aria-hidden />
            Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Deleting this account immediately and permanently removes:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>every case, conversation, approval, and audit record;</li>
              <li>all connected integrations (Shopify, Gmail, Sheets, LLM keys);</li>
              <li>
                your organization and every manager&apos;s access to this
                dashboard.
              </li>
            </ul>
            <p className="font-medium text-foreground">
              This cannot be undone. A confirmation email is sent when it
              completes.
            </p>
          </div>

          <DeleteAccountForm tenantName={ctx.tenantName} />
        </CardContent>
      </Card>
    </div>
  );
}
