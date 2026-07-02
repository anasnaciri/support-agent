import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";

import {
  getAuthSession,
  isOnboardingRequired,
  login,
  onboard,
  OnboardError,
} from "@/lib/auth/session-api";
import { getWorkspaces } from "@/lib/api-client";
import { onboardingDisposition } from "@/lib/onboarding-gate";
import { qk } from "@/lib/query-keys";
import { useAppNavigate } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

// Public shell for the auth/landing routes.

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm space-y-4 text-center">{children}</div>
    </div>
  );
}

export function SignInPage() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold tracking-tight">Guidezilla</h1>
      <p className="text-sm text-muted-foreground">
        Sign in to your support workspace.
      </p>
      <Button className="w-full" onClick={() => login("/")}>
        Sign in
      </Button>
      <button
        type="button"
        onClick={() => login("/", "sign-up")}
        className="text-sm text-primary hover:underline"
      >
        Create an account
      </button>
    </Centered>
  );
}

export function GoodbyePage() {
  // Shared by regular sign-out AND account deletion; `?deleted=1` (set by the
  // delete-account flow) shows the deletion-specific confirmation.
  const deleted =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("deleted") === "1";

  if (deleted) {
    return (
      <Centered>
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Your account has been deleted
        </h1>
        <p className="text-sm text-muted-foreground">
          Your account and all associated data have been permanently removed. A
          confirmation has been emailed to the address on file. Thanks for
          trying the platform.
        </p>
        <Button className="w-full" onClick={() => login("/", "sign-up")}>
          Create a new account
        </Button>
      </Centered>
    );
  }

  return (
    <Centered>
      <h1 className="text-xl font-semibold tracking-tight">Signed out</h1>
      <p className="text-sm text-muted-foreground">You’ve been signed out.</p>
      <Button className="w-full" onClick={() => login("/")}>
        Sign in again
      </Button>
    </Centered>
  );
}

export function NoAccessPage() {
  return (
    <Centered>
      <h1 className="text-xl font-semibold tracking-tight">No access</h1>
      <p className="text-sm text-muted-foreground">
        Your account isn’t part of a workspace yet. Ask an admin for an invite.
      </p>
    </Centered>
  );
}

const ONBOARD_ERROR: Record<string, string> = {
  bad_name: "Team name must be at least 2 characters.",
  bad_email: "Enter a valid notification email.",
  legal_acceptance_required:
    "Accept the data processing terms to continue.",
  org_create_failed: "We couldn't create your team. Please try again.",
  session_remint_failed:
    "Something went wrong finishing setup. Please try again.",
  workos_admin_not_configured:
    "Onboarding isn't available right now — please contact support.",
};

// Self-service onboarding for a signed-in user with no organization yet. Submits
// to POST /dashboard/auth/onboard, which provisions the WorkOS org server-side,
// re-mints the session cookie so it carries the org, and creates the first
// tenant — then we refetch the session/workspaces and enter the dashboard.
export function OnboardingPage() {
  const nav = useAppNavigate();
  const qc = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: qk.authSession,
    queryFn: getAuthSession,
    retry: false,
  });
  const workspacesQuery = useQuery({
    queryKey: qk.workspaces,
    queryFn: () => getWorkspaces(),
    enabled:
      sessionQuery.isSuccess && !isOnboardingRequired(sessionQuery.data),
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [legal, setLegal] = useState(false);
  const disposition = onboardingDisposition(
    sessionQuery.data ?? null,
    workspacesQuery.data ?? null,
  );

  // Seed the notification email from the signed-in user once (they can edit it).
  const seeded = useRef(false);
  const sessionEmail = sessionQuery.data?.user.email ?? null;
  useEffect(() => {
    if (!seeded.current && sessionEmail) {
      setEmail(sessionEmail);
      seeded.current = true;
    }
  }, [sessionEmail]);

  useEffect(() => {
    if (disposition === "redirect_home") nav.replace("/");
  }, [disposition, nav]);

  const mutation = useMutation({
    mutationFn: () =>
      onboard({
        name: name.trim(),
        notificationEmail: email.trim(),
        legalAccepted: legal,
      }),
    onSuccess: async () => {
      // The cookie now carries the org — refetch the gate and enter.
      await qc.invalidateQueries({ queryKey: qk.authSession });
      await qc.invalidateQueries({ queryKey: qk.workspaces });
      // Land on Today with the "workspace is ready" toast (mirrors the Next flow).
      nav.replace("/?onboarded=1");
    },
  });

  const errorCode =
    mutation.error instanceof OnboardError
      ? mutation.error.code
      : mutation.isError
        ? "unknown"
        : null;

  if (disposition === "loading" || disposition === "redirect_home") {
    return (
      <Centered>
        <h1 className="text-xl font-semibold tracking-tight">
          Opening your workspace
        </h1>
        <p className="text-sm text-muted-foreground">One moment…</p>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="space-y-5 text-left">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Set up your workspace
          </h1>
          <p className="pt-1 text-sm text-muted-foreground">
            Name your team and confirm where approval requests should go.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mutation.isPending) mutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Team name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={120}
              placeholder="Acme Support"
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
          <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <input
              type="checkbox"
              checked={legal}
              onChange={(e) => setLegal(e.target.checked)}
              required
              disabled={mutation.isPending}
              className="mt-1 size-4 rounded border-input"
            />
            <span className="text-muted-foreground">
              I accept the{" "}
              <span className="font-medium text-foreground">
                Data Processing Notice and Data Processing Addendum
              </span>
              .
            </span>
          </label>
          {errorCode ? (
            <Alert variant="warning">
              <AlertDescription>
                {ONBOARD_ERROR[errorCode] ??
                  "Something went wrong. Please try again."}
              </AlertDescription>
            </Alert>
          ) : null}
          <Button
            type="submit"
            className="w-full"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Create workspace & continue"}
          </Button>
        </form>
      </div>
    </Centered>
  );
}
