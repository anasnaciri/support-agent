import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, SendHorizontal, Sparkles } from "lucide-react";
import type { ModelsResponse } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { useCaseMutation } from "@/lib/use-case-mutation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * What the composer is for, decided by the case's state:
 *  - `reply`: the manager took the case over and writes the reply by hand.
 *  - `locked`: the agent owns the conversation — a read-only hint to take over.
 *
 * (The `approval` mode — a drafted agent reply awaiting the manager's call —
 * lands in Phase 4c alongside the ApprovalCard / BundleApprovalBar.)
 */
export type ComposerMode =
  | { readonly kind: "reply" }
  | { readonly kind: "locked"; readonly message: string };

interface ChatComposerProps {
  readonly workspaceId: string;
  readonly caseId: string;
  readonly customerEmail: string | null;
  /** Tenant model catalog + current rephrase model; null hides the picker. */
  readonly models: ModelsResponse | null;
  readonly mode: ComposerMode;
}

// The composer input grows with its content but is capped — past the cap it
// scrolls instead of pushing the send controls off-screen.
const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 260;

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
 * The bottom-of-chat composer for a taken-over case: a blank reply that sends on
 * the existing email thread, or a read-only hint while the agent is working.
 * "Rephrase with AI" rewrites the current text in place against the tenant's own
 * LLM credential.
 */
export function ChatComposer({
  workspaceId,
  caseId,
  customerEmail,
  models,
  mode,
}: ChatComposerProps) {
  const ctx = { workspaceId };
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(
    models?.rephraseModel ?? null,
  );

  const sendM = useCaseMutation({
    workspaceId,
    caseId,
    action: "reply",
    mutationFn: () => api.sendReply(ctx, caseId, text),
    onDone: (kind) => {
      if (kind === "sent") setText("");
    },
  });

  const rephraseM = useMutation({
    mutationFn: () => api.rephrase(ctx, text),
    onSuccess: (res) => {
      if (res.kind === "rephrased" && typeof res.text === "string") {
        setText(res.text);
        setError(null);
      } else {
        setError(rephraseErrorText(res.kind));
      }
    },
    onError: () => setError(rephraseErrorText("failed")),
  });

  const saveModelM = useMutation({
    mutationFn: (id: string) => api.setRephraseModel(ctx, id),
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Resize to fit the content, clamped to [MIN, MAX]; scroll past the cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(
      Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT),
      COMPOSER_MAX_HEIGHT,
    );
    el.style.height = `${next}px`;
    el.style.overflowY =
      el.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  if (mode.kind === "locked") {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {mode.message}
      </div>
    );
  }

  const empty = text.trim().length === 0;
  const showPicker = Boolean(models?.connected && models.entries.length > 0);
  const placeholder = customerEmail
    ? `Write a reply to ${customerEmail}…`
    : "Write a reply to the customer…";

  const onPickModel = (id: string) => {
    setSelectedModel(id);
    saveModelM.mutate(id);
  };

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          className="min-h-[64px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => rephraseM.mutate()}
              disabled={empty || rephraseM.isPending}
              title="Rewrite your draft to be clearer and more professional"
            >
              <Sparkles aria-hidden />
              {rephraseM.isPending ? "Rephrasing…" : "Rephrase"}
            </Button>
            {showPicker ? (
              <RephraseModelPicker
                entries={models!.entries}
                value={selectedModel}
                onSelect={onPickModel}
                disabled={rephraseM.isPending}
              />
            ) : null}
          </div>

          <Button
            type="button"
            size="icon"
            onClick={() => sendM.mutate()}
            disabled={empty || sendM.isPending}
            aria-label="Send reply"
            title="Send this reply to the customer on the existing email thread"
          >
            <SendHorizontal aria-hidden />
          </Button>
        </div>
      </div>
      {error ? <p className="px-1 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
