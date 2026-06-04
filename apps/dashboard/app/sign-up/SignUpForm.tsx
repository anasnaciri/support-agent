"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { startGoogleSignUp } from "./actions";

interface Props {
  readonly legalUrl: string | null;
}

export const SignUpForm = ({ legalUrl }: Props) => {
  const [state, formAction, pending] = useActionState(
    startGoogleSignUp,
    null as { readonly error?: string } | null,
  );

  return (
    <form action={formAction} className="space-y-4">
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
        <a href="/sign-in" className="font-medium text-primary hover:underline">
          Sign in
        </a>
      </p>
    </form>
  );
};
