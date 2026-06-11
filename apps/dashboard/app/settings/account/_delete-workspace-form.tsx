"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { deleteWorkspaceAction } from "./actions";

function SubmitButton({ armed }: { readonly armed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={!armed || pending}>
      {pending ? "Deleting…" : "Delete this workspace permanently"}
    </Button>
  );
}

/**
 * Typed-name confirmation for deleting the ACTIVE workspace only. Same
 * pattern as DeleteAccountForm; the server action re-checks the name and
 * the api refuses the org's last workspace.
 */
export function DeleteWorkspaceForm({
  workspaceName,
}: {
  readonly workspaceName: string;
}) {
  const [value, setValue] = useState("");
  const armed = value.trim() === workspaceName;

  return (
    <form action={deleteWorkspaceAction} className="space-y-3">
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
      <SubmitButton armed={armed} />
    </form>
  );
}
