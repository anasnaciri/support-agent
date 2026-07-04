import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { useAppNavigate } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { createWorkspaceOutcome } from "./create-workspace-outcome";

// Port of the Next /workspaces/new page (the WorkspaceSwitcher's "New
// workspace" target). Creates an additional workspace and switches into it.
export function NewWorkspacePage() {
  const { user, setActiveWorkspace } = useSession();
  const ctx = useWorkspaceCtx();
  const nav = useAppNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState(user.email ?? "");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.createWorkspace(ctx, {
        name: name.trim(),
        notificationEmail: email.trim(),
      }),
    onSuccess: async (res) => {
      const outcome = createWorkspaceOutcome(res);
      if (outcome.kind === "error") {
        setError(outcome.message);
        return;
      }
      if (outcome.kind === "legal_required") {
        nav.push(outcome.redirectTo);
        return;
      }
      // Refresh the switcher's list before selecting the new workspace so
      // setActiveWorkspace can resolve it, then land home with the toast.
      await queryClient.invalidateQueries({ queryKey: qk.workspaces });
      setActiveWorkspace(outcome.workspaceId);
      nav.replace(outcome.redirectTo);
    },
    onError: () =>
      setError("Could not create the workspace. Please try again."),
  });

  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">New workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A workspace runs one store end to end: its own Shopify connection,
            support mailbox, AI provider, tickets, knowledge base, and policies.
            Everyone in your team can switch between workspaces from the
            sidebar.
          </p>
          <p className="text-sm text-muted-foreground">
            You&apos;ll be switched into the new workspace — connect its store
            and mailbox from{" "}
            <span className="font-medium text-foreground">
              Settings → Integrations
            </span>
            .
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (mutation.isPending) return;
              setError(null);
              mutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="name">Workspace name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={120}
                placeholder="Second Store"
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notificationEmail">
                Notification email (for approval requests)
              </Label>
              <Input
                id="notificationEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={mutation.isPending}
              />
            </div>
            {error ? (
              <Alert variant="warning">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
