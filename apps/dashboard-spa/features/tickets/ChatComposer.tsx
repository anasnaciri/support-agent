import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Files,
  Paperclip,
  SendHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { BorderBeam } from "border-beam";
import type {
  ModelsResponse,
  TicketAttachmentSummary,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import {
  attachmentPickerState,
  attachmentSourceLabel,
} from "@/lib/attachment-picker";
import { formatAttachmentSize } from "@/lib/ticket-timeline";
import {
  OPTIMISTIC_MESSAGE_ID_PREFIX,
  appendOptimisticReply,
  buildOptimisticOutboundMessage,
} from "@/lib/optimistic-reply";
import { useApprovalDecision, useTicketMutation } from "@/lib/use-ticket-mutation";
import { composerBeam } from "@/lib/composer-beam";
import { useSystemPrefersDark, useThemePreference } from "@/lib/theme-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "./ConfirmButton";

/**
 * What the composer is for, decided by the ticket's state:
 *  - `approval`: a drafted agent reply is awaiting the manager's call. The draft
 *    fills the input; the controls become a gray Reject (✗) and the blue Send,
 *    which approves and sends the (possibly edited) draft.
 *  - `reply`: the manager took the ticket over and writes the reply by hand.
 *  - `locked`: the agent owns the conversation — a read-only hint to take over.
 */
export type ComposerMode =
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly draftBody: string;
      /** The approval's proposedInput — edited bodyText is merged onto it. */
      readonly proposedInput: unknown;
    }
  | { readonly kind: "reply" }
  | { readonly kind: "locked"; readonly message: string };

interface ChatComposerProps {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly customerEmail: string | null;
  /** Tenant model catalog + current rephrase model; null hides the picker. */
  readonly models: ModelsResponse | null;
  readonly mode: ComposerMode;
  /** True while the agent is actively working the ticket — lights the beam. */
  readonly processing: boolean;
}

// The composer input grows with its content but is capped — past the cap it
// scrolls instead of pushing the send controls off-screen.
const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 260;

// How long the faint typing beam lingers after the last keystroke, so it
// breathes through natural pauses instead of flickering per key.
const TYPING_BEAM_LINGER_MS = 1500;

const rephraseErrorText = (kind: string): string => {
  if (kind === "no_llm") return "Connect an AI provider in settings to rephrase.";
  if (kind === "empty_input") return "Write a draft first, then rephrase it.";
  return "Couldn't rephrase the draft. Please try again.";
};

// Mirrors the server allowlist so a wrong pick fails in the picker, not after
// a 10 MB upload. The server re-validates (with a magic-byte sniff) regardless.
const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;

const uploadErrorText = (error: string): string => {
  if (error === "unsupported_type")
    return "Only images (PNG, JPEG, GIF, WEBP) and PDFs can be attached.";
  if (error === "too_large") return "Attachments are limited to 10 MB.";
  if (error === "content_mismatch")
    return "That file's contents don't match its type, so it can't be attached.";
  return "Couldn't upload the attachment. Please try again.";
};

/**
 * Attach a file that already lives on this ticket — the file a fulfillment partner sent
 * back, a customer's photo, or something the team uploaded on an earlier
 * reply. Staging one costs no upload: the reply carries its existing id.
 */
function TicketFilePicker({
  available,
  atCapacity,
  onPick,
  disabled,
}: {
  readonly available: ReadonlyArray<TicketAttachmentSummary>;
  readonly atCapacity: boolean;
  readonly onPick: (attachment: TicketAttachmentSummary) => void;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Attach a file already on this ticket"
      >
        <Files aria-hidden />
        Ticket files
      </Button>
      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-80 overflow-auto rounded-md border border-border bg-card p-1 shadow-md">
            {atCapacity ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                This reply is already carrying the maximum number of
                attachments.
              </p>
            ) : null}
            {available.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={atCapacity}
                onClick={() => {
                  onPick(a);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                <Paperclip
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{a.filename}</span>
                  <span className="block text-xs text-muted-foreground">
                    {attachmentSourceLabel(a.source)} ·{" "}
                    {formatAttachmentSize(a.sizeBytes)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

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
 * The bottom-of-chat composer. One control that adapts to who owns the ticket:
 * it carries the drafted reply for an approval (Approve/Reject), a blank reply
 * for a taken-over ticket (Send), or a read-only hint while the agent is working.
 * "Rephrase with AI" rewrites the current text in place against the tenant's own
 * LLM credential.
 */
export function ChatComposer({
  workspaceId,
  ticketId,
  customerEmail,
  models,
  mode,
  processing,
}: ChatComposerProps) {
  const ctx = { workspaceId };
  const qc = useQueryClient();
  const [text, setText] = useState(
    mode.kind === "approval" ? mode.draftBody : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(
    models?.rephraseModel ?? null,
  );
  // Files staged for THIS message. Each is already uploaded + indexed on the
  // ticket; send/approve passes only their ids (storage keys never reach the
  // client). Removing a chip just unstages it — the upload stays on the ticket.
  const [attachments, setAttachments] = useState<TicketAttachmentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Files already indexed on this ticket (fulfillment partner answers, customer photos,
  // earlier uploads) — offered in the picker so forwarding one costs no upload.
  const indexQ = useQuery({
    queryKey: qk.ticketAttachments(workspaceId, ticketId),
    queryFn: () => api.ticketAttachments(ctx, ticketId),
    // A locked composer can't attach anything — don't fetch the index for it.
    enabled: mode.kind !== "locked",
  });
  const picker = attachmentPickerState({
    index: indexQ.data?.attachments ?? [],
    staged: attachments,
    max: MAX_ATTACHMENTS,
  });

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = [...files];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (attachments.length + picked.length > MAX_ATTACHMENTS) {
      setError(`A reply can carry at most ${MAX_ATTACHMENTS} attachments.`);
      return;
    }
    if (picked.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
      setError(uploadErrorText("too_large"));
      return;
    }
    setUploading(true);
    setError(null);
    try {
      for (const file of picked) {
        const result = await api.uploadTicketAttachment(ctx, ticketId, file);
        if (result.kind === "rejected") {
          setError(uploadErrorText(result.error));
          return;
        }
        setAttachments((prev) => [...prev, result.attachment]);
      }
      // The upload is indexed on the ticket the moment it lands, so refresh the
      // picker: unstaging a chip must leave the file reachable again.
      void qc.invalidateQueries({
        queryKey: qk.ticketAttachments(workspaceId, ticketId),
      });
    } catch {
      setError(uploadErrorText("failed"));
    } finally {
      setUploading(false);
    }
  };
  const theme = useThemePreference();
  const systemPrefersDark = useSystemPrefersDark();
  const approvalId = mode.kind === "approval" ? mode.approvalId : "";

  // Optimistic send: drop a pulsing outbound bubble into the thread cache the
  // instant Send is pressed, then either keep it (the ticket refetch on success
  // swaps in the real message) or roll the cache back if the request fails.
  const sendM = useTicketMutation<
    void,
    {
      readonly key: QueryKey;
      readonly previous: TicketConversationThreadResult | undefined;
    }
  >({
    workspaceId,
    ticketId,
    action: "reply",
    mutationFn: () =>
      api.sendReply(
        ctx,
        ticketId,
        text,
        attachments.map((a) => a.id),
      ),
    onMutate: async () => {
      const key = qk.ticketThread(workspaceId, ticketId);
      // Stop any in-flight thread refetch from clobbering the placeholder.
      await qc.cancelQueries({ queryKey: key });
      const previous =
        qc.getQueryData<TicketConversationThreadResult>(key);
      const thread =
        previous?.status === "available" ? previous.thread : null;
      const optimistic = buildOptimisticOutboundMessage({
        id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}${Date.now()}`,
        bodyText: text,
        customerEmail,
        thread,
        sentAt: new Date().toISOString(),
      });
      qc.setQueryData<TicketConversationThreadResult>(key, (old) =>
        appendOptimisticReply(old, optimistic),
      );
      return { key, previous };
    },
    onError: (rollback) => {
      if (rollback) qc.setQueryData(rollback.key, rollback.previous);
    },
    onDone: (kind) => {
      if (kind === "sent") {
        setText("");
        setAttachments([]);
      }
    },
  });

  // Edit-and-Approve: merge the edited bodyText onto the approval's original
  // proposedInput so the shape stays valid for the gated tool (no extra fetch —
  // the ticket detail already carries proposedInput). Files staged here are
  // appended to the draft's own attachmentIds; the tool re-validates every id
  // within this ticket at resume time. Non-reply approvals send no override
  // and run against the original at resume time.
  const approvedInput = (): unknown => {
    if (mode.kind !== "approval") return undefined;
    const p = mode.proposedInput;
    if (!p || typeof p !== "object" || !("bodyText" in (p as object))) {
      return undefined;
    }
    const record = p as Record<string, unknown>;
    const draftIds = Array.isArray(record["attachmentIds"])
      ? (record["attachmentIds"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    const mergedIds = [
      ...new Set([...draftIds, ...attachments.map((a) => a.id)]),
    ];
    return {
      ...record,
      bodyText: text,
      ...(mergedIds.length > 0 ? { attachmentIds: mergedIds } : {}),
    };
  };
  const approveM = useApprovalDecision({
    workspaceId,
    ticketId,
    action: "approve",
    mutationFn: () => api.approveApproval(ctx, approvalId, approvedInput()),
  });
  const rejectM = useApprovalDecision({
    workspaceId,
    ticketId,
    action: "reject",
    mutationFn: () => api.rejectApproval(ctx, approvalId),
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

  // The typing signal for the beam: lit on each keystroke, cleared after a
  // linger so it fades out when the manager pauses. Only real keystrokes set
  // it — programmatic setText (rephrase success) doesn't go through onChange.
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTyping = () => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(
      () => setTyping(false),
      TYPING_BEAM_LINGER_MS,
    );
  };
  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    [],
  );

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

  // The locked hint is what's on screen while the agent works the ticket, so
  // it carries the processing beam; the editable composer only beams while a
  // rephrase is in flight (processing rarely overlaps an editable mode).
  if (mode.kind === "locked") {
    const lockedBeam = composerBeam({
      processing,
      rephrasing: false,
      typing: false,
      theme,
      systemPrefersDark,
    });
    return (
      <BorderBeam
        size="md"
        colorVariant="ocean"
        theme={lockedBeam.theme}
        strength={lockedBeam.strength}
        active={lockedBeam.active}
      >
        <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {mode.message}
        </div>
      </BorderBeam>
    );
  }

  const empty = text.trim().length === 0;
  const showPicker = Boolean(models?.connected && models.entries.length > 0);
  const busy =
    approveM.isPending || rejectM.isPending || sendM.isPending || uploading;
  const placeholder =
    mode.kind === "approval"
      ? "Edit the drafted reply before approving…"
      : customerEmail
        ? `Write a reply to ${customerEmail}…`
        : "Write a reply to the customer…";

  const onPickModel = (id: string) => {
    setSelectedModel(id);
    saveModelM.mutate(id);
  };

  const beam = composerBeam({
    processing,
    rephrasing: rephraseM.isPending,
    typing,
    theme,
    systemPrefersDark,
  });

  return (
    <div className="space-y-2">
      <BorderBeam
        size="md"
        colorVariant="ocean"
        theme={beam.theme}
        strength={beam.strength}
        active={beam.active}
      >
        <div className="rounded-xl border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
            setText(e.target.value);
            noteTyping();
          }}
            placeholder={placeholder}
            className="min-h-[64px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs"
                >
                  <Paperclip className="size-3 shrink-0" aria-hidden />
                  <span className="max-w-[14rem] truncate">{a.filename}</span>
                  <span className="text-muted-foreground">
                    {formatAttachmentSize(a.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.filename}`}
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((x) => x.id !== a.id),
                      )
                    }
                    className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => void onPickFiles(e.target.files)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                title="Attach an image or PDF to send with this reply"
              >
                <Paperclip aria-hidden />
                {uploading ? "Uploading…" : "Attach"}
              </Button>
              {picker.show ? (
                <TicketFilePicker
                  available={picker.available}
                  atCapacity={picker.atCapacity}
                  onPick={(a) => setAttachments((prev) => [...prev, a])}
                  disabled={uploading}
                />
              ) : null}
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

            {mode.kind === "approval" ? (
              <div className="flex items-center gap-2">
                <ConfirmButton
                  size="icon"
                  variant="secondary"
                  className="rounded-full"
                  aria-label="Reject this draft and take over"
                  title="Reject this approval?"
                  confirmLabel="Reject & take over"
                  description="No customer reply goes out, and the ticket escalates to human takeover. You'll handle it manually from there."
                  pending={rejectM.isPending}
                  onConfirm={() => rejectM.mutate()}
                >
                  <X aria-hidden />
                </ConfirmButton>
                <Button
                  type="button"
                  size="icon"
                  onClick={() => approveM.mutate()}
                  disabled={busy}
                  aria-label="Approve and send"
                  title="Approve and send this reply to the customer"
                >
                  <SendHorizontal aria-hidden />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={() => sendM.mutate()}
                disabled={empty || sendM.isPending || uploading}
                aria-label="Send reply"
                title="Send this reply to the customer on the existing email thread"
              >
                <SendHorizontal aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </BorderBeam>
      {error ? <p className="px-1 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
