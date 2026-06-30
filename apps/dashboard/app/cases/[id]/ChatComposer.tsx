"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, SendHorizontal, Sparkles, X } from "lucide-react";
import type { ModelsResponse } from "@support-agent/dashboard-contracts";

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { approveAction, rejectAction } from "../../approvals/[id]/actions";
import {
  rephraseAction,
  sendReplyAction,
  setRephraseModelAction,
} from "./actions";

/**
 * What the composer is for, decided by the case's state on the server:
 *  - `approval`: a drafted agent reply is awaiting the manager's call. The draft
 *    fills the input; the send control becomes Approve (✓) / Reject (✗).
 *  - `reply`: the manager has taken the case over and writes the reply by hand.
 *  - `locked`: the agent owns the conversation — the input is read-only with a
 *    hint to take over.
 */
export type ComposerMode =
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly draftBody: string;
      readonly returnTo: string;
    }
  | { readonly kind: "reply" }
  | { readonly kind: "locked"; readonly message: string };

interface ChatComposerProps {
  readonly caseId: string;
  readonly customerEmail: string | null;
  /** Tenant model catalog + current rephrase model; null hides the picker. */
  readonly models: ModelsResponse | null;
  readonly mode: ComposerMode;
}

const rephraseErrorText = (kind: string): string => {
  if (kind === "no_llm") return "Connect an AI provider in settings to rephrase.";
  if (kind === "empty_input") return "Write a draft first, then rephrase it.";
  return "Couldn't rephrase the draft. Please try again.";
};

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
        <span className="max-w-[12rem] truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-64 overflow-auto rounded-md border border-border bg-card p-1 shadow-md">
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

/**
 * The bottom-of-chat composer. One control that adapts to who owns the case:
 * it carries the drafted reply for an approval (Approve/Reject), a blank reply
 * for a taken-over case (Send), or a read-only hint while the agent is working.
 * The send/approve/reject controls are icon-only. "Rephrase with AI" rewrites
 * the current text in place against the tenant's own LLM credential.
 */
export function ChatComposer({
  caseId,
  customerEmail,
  models,
  mode,
}: ChatComposerProps) {
  const [text, setText] = useState(
    mode.kind === "approval" ? mode.draftBody : "",
  );
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

  if (mode.kind === "locked") {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {mode.message}
      </div>
    );
  }

  const placeholder =
    mode.kind === "approval"
      ? "Edit the drafted reply before approving…"
      : customerEmail
        ? `Write a reply to ${customerEmail}…`
        : "Write a reply to the customer…";

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={placeholder}
          className="min-h-[64px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRephrase}
              disabled={empty || rephrasing}
              title="Rewrite your draft to be clearer and more professional"
            >
              <Sparkles aria-hidden />
              {rephrasing ? "Rephrasing…" : "Rephrase"}
            </Button>
            {showPicker ? (
              <RephraseModelPicker
                entries={models!.entries}
                value={selectedModel}
                onSelect={onPickModel}
                disabled={rephrasing}
              />
            ) : null}
          </div>

          {mode.kind === "approval" ? (
            <div className="flex items-center gap-1.5">
              <form action={rejectAction}>
                <input type="hidden" name="approvalId" value={mode.approvalId} />
                <input type="hidden" name="returnTo" value={mode.returnTo} />
                <ConfirmSubmitButton
                  size="icon"
                  aria-label="Reject this draft and take over"
                  title="Reject this approval?"
                  confirmLabel="Reject & take over"
                  description="No customer reply goes out, and the case escalates to human takeover — you'll handle it manually from there."
                >
                  <X aria-hidden />
                </ConfirmSubmitButton>
              </form>
              <form action={approveAction}>
                <input type="hidden" name="approvalId" value={mode.approvalId} />
                <input type="hidden" name="returnTo" value={mode.returnTo} />
                <input type="hidden" name="bodyText" value={text} />
                <SubmitButton
                  size="icon"
                  variant="success"
                  aria-label="Approve and send"
                  title="Approve and send this reply to the customer"
                >
                  <Check aria-hidden />
                </SubmitButton>
              </form>
            </div>
          ) : (
            <form action={sendReplyAction}>
              <input type="hidden" name="caseId" value={caseId} />
              <input type="hidden" name="bodyText" value={text} />
              <SubmitButton
                size="icon"
                disabled={empty}
                aria-label="Send reply"
                title="Send this reply to the customer on the existing email thread"
              >
                <SendHorizontal aria-hidden />
              </SubmitButton>
            </form>
          )}
        </div>
      </div>
      {error ? <p className="px-1 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
