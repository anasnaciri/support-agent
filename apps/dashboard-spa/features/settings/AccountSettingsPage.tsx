import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { useAppNavigate } from "@/lib/navigation";
import { logout } from "@/lib/auth/session-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";

// The Next actions used post-redirect-get (`?error=<code>`) read by a FEEDBACK
// rule array; here we fire the same copy directly from the mutation callbacks.
// A failed delete is a hard error (red); a name-mismatch / last-workspace guard
// is a softer warning — same split the inline banner drew.
const ERROR_COPY = {
  name_mismatch: "The name you typed didn't match. Nothing was deleted.",
  workspace_name_mismatch:
    "The workspace name you typed didn't match. Nothing was deleted.",
  last_workspace:
    "This is your only workspace — deleting it would delete your whole account. Use “Delete account” below instead.",
  workspace_delete_failed:
    "We couldn't delete the workspace. Please try again, or contact support if this keeps happening.",
  delete_failed:
    "We couldn't delete the account. Please try again, or contact support if this keeps happening.",
} as const;

/**
 * Typed-name confirmation for deleting the ACTIVE workspace only. The org, the
 * other workspaces, and the manager's session all survive — afterwards the
 * dashboard switches to a sibling workspace. The typed-name gate arms the
 * destructive button; the api re-checks the name and refuses the org's last
 * workspace.
 */
function DeleteWorkspaceForm({
  workspaceName,
}: {
  readonly workspaceName: string;
}) {
  const ctx = useWorkspaceCtx();
  const session = useSession();
  const qc = useQueryClient();
  const nav = useAppNavigate();
  const [value, setValue] = useState("");
  const armed = value.trim() === workspaceName;

  const mutation = useMutation({
    mutationFn: () => api.deleteWorkspace(ctx, ctx.workspaceId),
    onSuccess: (res) => {
      if (res.status === 409) {
        toast.warning(ERROR_COPY.last_workspace);
        return;
      }
      if (res.status !== 200) {
        toast.error(ERROR_COPY.workspace_delete_failed);
        return;
      }
      // Switch away from the just-deleted workspace, then drop the stale
      // workspace list so the switcher no longer shows it.
      const sibling = session.workspaces.find(
        (w) => w.id !== ctx.workspaceId,
      );
      if (sibling) session.setActiveWorkspace(sibling.id);
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success("Workspace deleted", {
        description: sibling
          ? `You're back in ${sibling.name}. The deleted workspace's data and connections are being cleaned up.`
          : "The deleted workspace's data and connections are being cleaned up.",
      });
      nav.push("/");
    },
    onError: () => toast.error(ERROR_COPY.workspace_delete_failed),
  });

  // Re-check client-side (mirrors the server action) before firing the delete.
  const onConfirm = () => {
    if (value.trim() !== workspaceName) {
      toast.warning(ERROR_COPY.workspace_name_mismatch);
      return;
    }
    if (session.workspaces.length <= 1) {
      toast.warning(ERROR_COPY.last_workspace);
      return;
    }
    mutation.mutate();
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="confirm-workspace">
          Type{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
            {workspaceName}
          </code>{" "}
          to confirm
        </Label>
        <Input
          id="confirm-workspace"
          name="confirm"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={workspaceName}
        />
      </div>
      <ConfirmButton
        title="Delete this workspace permanently?"
        description={`This permanently removes the ${workspaceName} workspace and all its tickets, conversations, approvals, audit records, and connected integrations. Your other workspaces are not affected. This cannot be undone.`}
        confirmLabel="Delete workspace"
        pending={mutation.isPending}
        disabled={!armed}
        onConfirm={onConfirm}
      >
        {mutation.isPending ? "Deleting…" : "Delete this workspace permanently"}
      </ConfirmButton>
    </div>
  );
}

/**
 * Typed-name confirmation gate for deleting the WHOLE account. The api wipes
 * every tenant row synchronously and hands the WorkOS-org delete + deletion
 * email to the worker. On success we sign the manager out (their session is now
 * orphaned — tenant + org are gone) and land them on /goodbye. The typed-name
 * gate is UX; the api is the security boundary.
 */
function DeleteAccountForm({ tenantName }: { readonly tenantName: string }) {
  const ctx = useWorkspaceCtx();
  const [value, setValue] = useState("");
  const armed = value.trim() === tenantName;

  const mutation = useMutation({
    mutationFn: () => api.deleteAccount(ctx),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.error(ERROR_COPY.delete_failed);
        return;
      }
      // Session is now orphaned — sign out and land on the deletion-specific
      // goodbye page.
      void logout("/goodbye?deleted=1");
    },
    onError: () => toast.error(ERROR_COPY.delete_failed),
  });

  const onConfirm = () => {
    if (value.trim() !== tenantName) {
      toast.warning(ERROR_COPY.name_mismatch);
      return;
    }
    mutation.mutate();
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="confirm">
          Type{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
            {tenantName}
          </code>{" "}
          to confirm
        </Label>
        <Input
          id="confirm"
          name="confirm"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={tenantName}
        />
      </div>
      <ConfirmButton
        title="Delete this account permanently?"
        description="This immediately and permanently removes every workspace, all connected integrations, and every manager's access to this dashboard. This cannot be undone."
        confirmLabel="Delete account"
        pending={mutation.isPending}
        disabled={!armed}
        onConfirm={onConfirm}
      >
        {mutation.isPending ? "Deleting…" : "Delete this account permanently"}
      </ConfirmButton>
    </div>
  );
}

export function AccountSettingsPage() {
  const allowed = useRequirePermission("account.manage");
  const session = useSession();
  if (!allowed) return null;

  const tenantName = session.activeWorkspace.name;
  const workspaces = session.workspaces;
  const multiWorkspace = workspaces.length > 1;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Delete account" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Delete account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Delete the <span className="font-medium">{tenantName}</span>{" "}
          workspace, or the whole account.
        </p>
      </div>

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
                  {tenantName}
                </span>{" "}
                workspace: its tickets, conversations, approvals, audit records,
                and connected integrations. Your other{" "}
                {workspaces.length - 1 === 1 ? "workspace" : "workspaces"} and
                your team&apos;s sign-in are not affected.
              </p>
              <p className="font-medium text-foreground">
                This cannot be undone.
              </p>
            </div>
            <DeleteWorkspaceForm workspaceName={tenantName} />
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
                    all {workspaces.length} workspaces
                  </span>{" "}
                  ({workspaces.map((w) => w.name).join(", ")}) including:
                </>
              ) : (
                ":"
              )}
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>every ticket, conversation, approval, and audit record;</li>
              <li>
                all connected integrations (Shopify, Gmail, Sheets, AI keys);
              </li>
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

          <DeleteAccountForm tenantName={tenantName} />
        </CardContent>
      </Card>
    </div>
  );
}
