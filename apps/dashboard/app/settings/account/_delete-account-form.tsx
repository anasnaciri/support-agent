"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { deleteAccountAction } from "./actions";

function SubmitButton({ armed }: { readonly armed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={!armed || pending}>
      {pending ? "Deleting…" : "Delete this account permanently"}
    </Button>
  );
}

/**
 * Typed-name confirmation gate. The destructive submit stays disabled until
 * the manager types the exact tenant name — mirrors the GitHub delete-repo
 * pattern. The server action re-checks the name, so this is UX, not the
 * security boundary.
 */
export function DeleteAccountForm({
  tenantName,
}: {
  readonly tenantName: string;
}) {
  const [value, setValue] = useState("");
  const armed = value.trim() === tenantName;

  return (
    <form action={deleteAccountAction} className="space-y-3">
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
      <SubmitButton armed={armed} />
    </form>
  );
}
