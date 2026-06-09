"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { startGoogleSignUp } from "./actions";

interface Props {
  readonly legalUrl: string | null;
  /**
   * The page to return to after auth (a session-expired user re-signing in).
   * Forwarded to the action as a hidden field; empty for a fresh sign-up.
   */
  readonly returnTo?: string;
}

export const SignUpForm = ({ legalUrl, returnTo }: Props) => {
  const [state, formAction, pending] = useActionState(
    startGoogleSignUp,
    null as { readonly error?: string } | null,
  );

  // A returning user clicks "Sign in" rather than the Google sign-up button;
  // carry returnTo to the hosted-sign-in route so re-auth lands them back too.
  const signInHref = returnTo
    ? `/sign-in?returnTo=${encodeURIComponent(returnTo)}`
    : "/sign-in";

  return (
    <form action={formAction} className="space-y-4">
      {returnTo ? (
        <input type="hidden" name="returnTo" value={returnTo} />
      ) : null}
      <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <input
          type="checkbox"
          name="legalAccepted"
          required
          disabled={pending}
          className="mt-1 size-4 rounded border-input"
        />
        <span className="text-muted-foreground">
          I accept the{" "}
          {legalUrl ? (
            <a
              href={legalUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary hover:underline"
            >
              Data Processing Notice and Data Processing Addendum
            </a>
          ) : (
            <span className="font-medium text-foreground">
              Data Processing Notice and Data Processing Addendum
            </span>
          )}
          .
        </span>
      </label>
      {state?.error ? (
        <Alert variant="warning">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Redirecting…" : "Continue with Google"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <a
          href={signInHref}
          className="font-medium text-primary hover:underline"
        >
          Sign in
        </a>
      </p>
    </form>
  );
};
