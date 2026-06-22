"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelsResponse } from "@support-agent/dashboard-contracts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";

import {
  rephraseAction,
  sendReplyAction,
  setRephraseModelAction,
} from "./actions";

interface ReplyComposerProps {
  readonly caseId: string;
  /** Shown in the placeholder so the agent knows who they're writing to. */
  readonly customerEmail: string | null;
  /**
   * The tenant's model catalog + currently-configured rephrase model. `null`
   * when the member can't read it (lacks settings.agents) or no provider is
   * connected — the composer then renders without the model picker.
   */
  readonly models: ModelsResponse | null;
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

// Minimalistic model picker that sits on top of the draft: just the current
// model's name + a chevron. Opens a short list of the tenant's models; picking
// one persists it as the workspace rephrase model.
function RephraseModelPicker({
  entries,
  value,
  onSelect,
  disabled,
}: {
  readonly entries: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly value: string | null;
  readonly onSelect: (id: string) => void;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = value ? entries.find((e) => e.id === value) : undefined;
  const label = current?.name ?? value ?? "Default model";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        title="Model used by Rephrase with AI"
      >
        <span className="max-w-[14rem] truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute left-0 z-20 mt-1 max-h-64 w-64 overflow-auto rounded-md border border-border bg-card p-1 shadow-md">
            {entries.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  onSelect(e.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted",
                  e.id === value ? "font-medium" : undefined,
                )}
              >
                <span className="truncate">{e.name}</span>
                {e.id === value ? (
                  <Check className="size-3.5 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// Human draft-and-send composer. Only rendered while a human is driving the
// case (human_takeover), so no one races the agent to the customer's inbox.
// The reply goes out on the existing email thread; the case stays in
// human_takeover afterwards. "Rephrase with AI" rewrites the current draft in
// place against the tenant's own LLM credential, using the model the picker
// (above the draft) selects.
export function ReplyComposer({
  caseId,
  customerEmail,
  models,
}: ReplyComposerProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rephrasing, startRephrase] = useTransition();
  const [, startSaveModel] = useTransition();
  const [selectedModel, setSelectedModel] = useState<string | null>(
    models?.rephraseModel ?? null,
  );

  const empty = text.trim().length === 0;
  const showPicker = Boolean(models?.connected && models.entries.length > 0);

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

  const onPickModel = (id: string) => {
    setSelectedModel(id);
    startSaveModel(async () => {
      await setRephraseModelAction(id);
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
          {showPicker ? (
            <div className="flex items-center justify-end">
              <RephraseModelPicker
                entries={models!.entries}
                value={selectedModel}
                onSelect={onPickModel}
                disabled={rephrasing}
              />
            </div>
          ) : null}
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
