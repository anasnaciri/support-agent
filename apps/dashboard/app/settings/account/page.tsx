import { TriangleAlert } from "lucide-react";

import { requirePermission } from "@/lib/require-permission";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { DeleteAccountForm } from "./_delete-account-form";
import { DeleteWorkspaceForm } from "./_delete-workspace-form";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const ERROR_COPY: Record<string, string> = {
  name_mismatch: "The name you typed didn't match. Nothing was deleted.",
  workspace_name_mismatch:
    "The workspace name you typed didn't match. Nothing was deleted.",
  last_workspace:
    "This is your only workspace — deleting it would delete your whole account. Use “Delete account” below instead.",
  workspace_delete_failed:
    "We couldn't delete the workspace. Please try again, or contact support if this keeps happening.",
  delete_failed:
    "We couldn't delete the account. Please try again, or contact support if this keeps happening.",
};

export default async function AccountSettingsPage({ searchParams }: PageProps) {
  const ctx = await requirePermission("account.manage");
  const params = (await searchParams) ?? {};
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];
  const errorCopy = errorRaw ? ERROR_COPY[errorRaw] : undefined;
  const multiWorkspace = ctx.workspaces.length > 1;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Delete account" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Delete account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Delete the{" "}
          <span className="font-medium">{ctx.tenantName}</span> workspace, or
          the whole account.
        </p>
      </div>

      {errorCopy ? (
        <Alert
          variant={
            errorRaw === "delete_failed" || errorRaw === "workspace_delete_failed"
              ? "destructive"
              : "warning"
          }
        >
          <AlertDescription>{errorCopy}</AlertDescription>
        </Alert>
      ) : null}

      {multiWorkspace ? (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <TriangleAlert className="size-4" aria-hidden />
              Delete this workspace
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Permanently removes the{" "}
                <span className="font-medium text-foreground">
                  {ctx.tenantName}
                </span>{" "}
                workspace: its cases, conversations, approvals, audit records,
                and connected integrations. Your other{" "}
                {ctx.workspaces.length - 1 === 1
                  ? "workspace"
                  : "workspaces"}{" "}
                and your team&apos;s sign-in are not affected.
              </p>
              <p className="font-medium text-foreground">
                This cannot be undone.
              </p>
            </div>
            <DeleteWorkspaceForm workspaceName={ctx.tenantName} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-destructive/40">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <TriangleAlert className="size-4" aria-hidden />
            {multiWorkspace ? "Delete the whole account" : "Danger zone"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Deleting this account immediately and permanently removes
              {multiWorkspace ? (
                <>
                  {" "}
                  <span className="font-medium text-foreground">
                    all {ctx.workspaces.length} workspaces
                  </span>{" "}
                  (
                  {ctx.workspaces.map((w) => w.name).join(", ")}
                  ) including:
                </>
              ) : (
                ":"
              )}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>every case, conversation, approval, and audit record;</li>
              <li>all connected integrations (Shopify, Gmail, Sheets, AI keys);</li>
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
