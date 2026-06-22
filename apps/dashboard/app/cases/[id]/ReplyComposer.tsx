"use client";

import { useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";

import { rephraseAction, sendReplyAction } from "./actions";

interface ReplyComposerProps {
  readonly caseId: string;
  /** Shown in the placeholder so the agent knows who they're writing to. */
  readonly customerEmail: string | null;
}

const rephraseErrorText = (kind: string): string => {
  if (kind === "no_llm") {
    return "Connect an AI provider in settings to use rephrase.";
  }
  if (kind === "empty_input") {
    return "Write a draft first, then rephrase it.";
  }
  return "Couldn't rephrase the draft. Please try again.";
};

// Human draft-and-send composer. Only rendered while a human is driving the
// case (human_takeover), so no one races the agent to the customer's inbox.
// The reply goes out on the existing email thread; the case stays in
// human_takeover afterwards. "Rephrase with AI" rewrites the current draft in
// place against the tenant's own LLM credential. (Model picker lands next.)
export function ReplyComposer({ caseId, customerEmail }: ReplyComposerProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rephrasing, startRephrase] = useTransition();

  const empty = text.trim().length === 0;

  const onRephrase = () => {
    setError(null);
    startRephrase(async () => {
      const res = await rephraseAction(text);
      if (res.kind === "rephrased" && typeof res.text === "string") {
        setText(res.text);
      } else {
        setError(rephraseErrorText(res.kind));
      }
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reply to customer</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={sendReplyAction} className="space-y-3">
          <input type="hidden" name="caseId" value={caseId} />
          <Textarea
            name="bodyText"
            required
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              customerEmail
                ? `Write a reply to ${customerEmail}…`
                : "Write a reply to the customer…"
            }
            className="bg-card"
          />
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onRephrase}
              disabled={empty || rephrasing}
              title="Rewrite your draft to be clearer and more professional"
            >
              {rephrasing ? "Rephrasing…" : "Rephrase with AI"}
            </Button>
            <SubmitButton
              pendingLabel="Sending…"
              title="Send this reply to the customer on the existing email thread"
            >
              Send reply
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
