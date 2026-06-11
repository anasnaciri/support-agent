"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

import {
  createWorkspaceAction,
  type CreateWorkspaceFormState,
} from "./actions";

interface Props {
  readonly defaultEmail: string | null;
}

export const NewWorkspaceForm = ({ defaultEmail }: Props) => {
  const [state, formAction, pending] = useActionState(
    createWorkspaceAction,
    null as CreateWorkspaceFormState | null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Workspace name</Label>
        <Input
          id="name"
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Second Store"
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
      {state?.error ? (
        <Alert variant="warning">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
};
