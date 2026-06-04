"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { createTenantAction } from "./actions";

interface Props {
  readonly defaultEmail: string | null;
  readonly legalUrl: string | null;
  /**
   * ISO timestamp when the user accepted the notice + DPA at sign-up. When set,
   * we show a passive confirmation instead of a second required checkbox.
   */
  readonly alreadyAcceptedAt: string | null;
}

export const OnboardingForm = ({
  defaultEmail,
  legalUrl,
  alreadyAcceptedAt,
}: Props) => {
  const [state, formAction, pending] = useActionState(
    createTenantAction,
    null as { readonly error?: string } | null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Team name</Label>
        <Input
          id="name"
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Acme Support"
          disabled={pending}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notificationEmail">
          Notification email (for approval requests)
        </Label>
        <Input
          id="notificationEmail"
          type="email"
          name="notificationEmail"
          required
          defaultValue={defaultEmail ?? ""}
          disabled={pending}
        />
      </div>
      {alreadyAcceptedAt ? (
        <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          You accepted the{" "}
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
          )}{" "}
          at sign-up.
        </p>
      ) : (
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
      )}
      {state?.error ? (
        <Alert variant="warning">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create tenant & continue"}
      </Button>
    </form>
  );
};
