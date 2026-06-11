"use client";

import { useActionState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";

import { createKnowledgeAction, type KnowledgeCreateState } from "./actions";
import { knowledgeErrorMessage } from "./_messages";

interface Props {
  /** Which create form this renders: paste-a-document or add-from-URL. */
  readonly sourceType: "text" | "url";
}

// useActionState (the onboarding/sign-up pattern, U4): on failure the action
// returns an error state and React re-renders WITHOUT navigating, so the
// merchant's input — possibly a large pasted policy document — survives a
// failed URL fetch or validation error. Success redirects to ?saved=1.
export const KnowledgeCreateForm = ({ sourceType }: Props) => {
  const [state, formAction, pending] = useActionState(
    createKnowledgeAction,
    null as KnowledgeCreateState | null,
  );
  const idPrefix = sourceType === "url" ? "url" : "paste";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="sourceType" value={sourceType} />
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-title`}>Title</Label>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          placeholder={sourceType === "url" ? "Shipping policy" : "Returns policy"}
          required
          disabled={pending}
        />
      </div>
      {sourceType === "url" ? (
        <div className="grid gap-2">
          <Label htmlFor="url-source">Page URL</Label>
          <Input
            id="url-source"
            name="sourceUrl"
            type="url"
            inputMode="url"
            placeholder="https://yourstore.com/policies/shipping"
            required
            disabled={pending}
            aria-describedby="url-hint"
          />
          <p id="url-hint" className="text-xs text-muted-foreground">
            We fetch the page once and store a snapshot of its text. You can
            re-sync it later from the document&apos;s page.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="paste-content">Text</Label>
          <Textarea
            id="paste-content"
            name="content"
            rows={8}
            placeholder="Paste your shipping policy, returns policy, FAQ, …"
            required
            disabled={pending}
          />
        </div>
      )}
      {state?.error ? (
        <Alert variant="warning">
          <AlertDescription>
            {knowledgeErrorMessage(state.error)}
          </AlertDescription>
        </Alert>
      ) : null}
      <SubmitButton pendingLabel={sourceType === "url" ? "Fetching…" : "Saving…"}>
        {sourceType === "url" ? "Fetch & save" : "Save document"}
      </SubmitButton>
    </form>
  );
};
