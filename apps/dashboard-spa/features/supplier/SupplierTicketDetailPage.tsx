import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { TicketAttachmentSummary } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { cn } from "@/lib/utils";
import {
  supplierChatMessages,
  trackingEditFeedback,
  type SupplierChatMessage,
} from "@/lib/supplier-ticket-chat";
import { Link } from "@/components/ui/link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// The escalation as a chat: the support team's request is an inbound bubble,
// the supplier's posted update the outbound reply, and the "post an update"
// form the composer pinned at the bottom (posting flips the ticket to resolved).
// The order context lives in a card pinned to the chat's top right: it slides
// in from behind the stage's right edge and an invisible spacer column widens
// with it, nudging the bubbles left instead of letting the card cover them.

/** Width reserved for the context card's invisible column (card + gutters). */
const CONTEXT_COLUMN = "md:w-80";

// Mirrors the server allowlist so a wrong pick fails at the picker; the
// server re-validates (magic-byte sniff) regardless.
const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;

const uploadErrorMessage = (error: string): string => {
  if (error === "unsupported_type")
    return "Only images (PNG, JPEG, GIF, WEBP) and PDFs can be attached.";
  if (error === "too_large") return "Files are limited to 10 MB.";
  if (error === "content_mismatch")
    return "That file's contents don't match its type, so it can't be attached.";
  return "Couldn't upload the file. Please try again.";
};

const formatDateTime = (date: string): string =>
  date.slice(0, 16).replace("T", " ");

const Field = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}) =>
  value ? (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="pt-0.5 text-sm">{value}</dd>
    </div>
  ) : null;

// The Tracking row of the context card, editable while the escalation is
// open: the pencil swaps the value for a two-field form (new number +
// optional carrier) that writes the correction to the real order. Resolved
// escalations render the plain read-only Field instead.
const TrackingField = ({
  escalationId,
  current,
}: {
  readonly escalationId: string;
  readonly current: string | null;
}) => {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.supplierUpdateTracking(ctx, escalationId, {
        trackingNumber: trackingNumber.trim(),
        trackingCompany: carrier.trim() ? carrier.trim() : null,
      }),
    onSuccess: (res) => {
      const feedback = trackingEditFeedback(res.status, res.body);
      if (feedback.kind !== "success") {
        toast.warning(feedback.message);
        return;
      }
      toast.success(feedback.message);
      setEditing(false);
      void qc.invalidateQueries({
        queryKey: qk.supplierTicket(ctx.workspaceId, escalationId),
      });
      void qc.invalidateQueries({
        queryKey: qk.supplierTickets(ctx.workspaceId),
      });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!trackingNumber.trim()) return;
    save.mutate();
  };

  return (
    <div>
      <dt className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Tracking
        {!editing ? (
          <button
            type="button"
            aria-label="Change tracking number"
            title="Change tracking number"
            onClick={() => {
              setTrackingNumber(current ?? "");
              setCarrier("");
              setEditing(true);
            }}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Pencil className="size-3" aria-hidden />
          </button>
        ) : null}
      </dt>
      {editing ? (
        <dd className="pt-1.5">
          <form onSubmit={onSubmit} className="space-y-2">
            <Input
              aria-label="New tracking number"
              required
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              placeholder="New tracking number"
              className="h-8 text-sm"
            />
            <Input
              aria-label="Carrier (optional)"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="Carrier (optional, e.g. DHL)"
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={save.isPending || !trackingNumber.trim()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </dd>
      ) : (
        <dd className="pt-0.5 text-sm">{current ?? "—"}</dd>
      )}
    </div>
  );
};

const Bubble = ({ message }: { readonly message: SupplierChatMessage }) => {
  const outbound = message.direction === "outbound";
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        outbound ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "flex max-w-[85%] min-w-0 items-center gap-2 px-1 text-[0.6875rem] text-muted-foreground",
          outbound ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className="min-w-0 truncate font-medium text-foreground/70">
          {message.sender}
        </span>
        {message.sentAt ? (
          <>
            <span>·</span>
            <span className="font-mono">{formatDateTime(message.sentAt)}</span>
          </>
        ) : null}
      </div>
      <div
        className={cn(
          "max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
          outbound
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border border-border bg-card text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.resolution ? (
          <p className="mt-2 border-t border-primary-foreground/25 pt-2 text-[0.8125rem] text-primary-foreground/85">
            Suggested resolution: {message.resolution}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export function SupplierTicketDetailPage() {
  const allowed = useRequirePermission("supplier.tickets.view");
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { escalationId?: string }).escalationId ?? "";
  const qc = useQueryClient();

  const [note, setNote] = useState("");
  const [proposedResolution, setProposedResolution] = useState("");
  const [contextOpen, setContextOpen] = useState(true);
  // Files staged for this update — uploaded immediately, referenced by id on
  // submit. The support agent can forward them to the customer.
  const [attachments, setAttachments] = useState<TicketAttachmentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = [...files];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (attachments.length + picked.length > MAX_ATTACHMENTS) {
      toast.warning(`An update can carry at most ${MAX_ATTACHMENTS} files.`);
      return;
    }
    if (picked.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
      toast.warning(uploadErrorMessage("too_large"));
      return;
    }
    setUploading(true);
    try {
      for (const file of picked) {
        const result = await api.uploadSupplierAttachment(ctx, id, file);
        if (result.kind === "rejected") {
          toast.warning(uploadErrorMessage(result.error));
          return;
        }
        setAttachments((prev) => [...prev, result.attachment]);
      }
    } catch {
      toast.warning(uploadErrorMessage("failed"));
    } finally {
      setUploading(false);
    }
  };

  const { data: detail, isLoading } = useQuery({
    queryKey: qk.supplierTicket(ctx.workspaceId, id),
    queryFn: () => api.supplierTicket(ctx, id),
    enabled: allowed && id.length > 0,
  });

  const update = useMutation({
    mutationFn: () =>
      api.supplierUpdate(ctx, id, {
        note,
        proposedResolution: proposedResolution.trim() ? proposedResolution : null,
        ...(attachments.length > 0
          ? { attachmentIds: attachments.map((a) => a.id) }
          : {}),
      }),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning(
          `We couldn't record that update (error ${res.status}). Please try again.`,
        );
        return;
      }
      toast.success(
        "Thanks — your update was recorded and the ticket is being handled.",
      );
      void qc.invalidateQueries({
        queryKey: qk.supplierTicket(ctx.workspaceId, id),
      });
      void qc.invalidateQueries({
        queryKey: qk.supplierTickets(ctx.workspaceId),
      });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate();
  };

  if (!allowed) return null;

  if (isLoading) {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-sm font-medium">Escalation not found</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/supplier/tickets">← All escalated tickets</Link>
          </Button>
        </div>
      </div>
    );
  }

  const resolved = detail.status === "resolved";
  const shipTo = [detail.shipCity, detail.shipCountry]
    .filter(Boolean)
    .join(", ");
  const messages = supplierChatMessages(detail);
  const hasContext = Boolean(detail.orderRef || detail.trackingNumber || shipTo);
  const showContext = contextOpen && hasContext;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4 py-2.5">
        <Link
          href="/supplier/tickets"
          aria-label="All escalated tickets"
          title="All escalated tickets"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {detail.orderRef ?? "Escalated ticket"}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {resolved
              ? "You've responded to this ticket."
              : "Review what's needed and post your update."}
          </p>
        </div>
        {hasContext ? (
          <button
            type="button"
            onClick={() => setContextOpen((v) => !v)}
            aria-expanded={contextOpen}
            aria-label={contextOpen ? "Hide order context" : "Show order context"}
            title={contextOpen ? "Hide order context" : "Show order context"}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {contextOpen ? (
              <PanelRightClose className="size-4" aria-hidden />
            ) : (
              <PanelRightOpen className="size-4" aria-hidden />
            )}
          </button>
        ) : null}
      </header>

      {/* The chat stage — overflow-hidden parks the context card just past the
          right edge, so opening it reads as sliding out from behind that edge. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="thin-scrollbar h-full min-w-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
          </div>
        </div>

        {/* The card's invisible column: an empty spacer that widens with the
            card (md+ only — on phones the card floats over the chat instead),
            pushing the centered bubble column left. */}
        <div
          aria-hidden
          className={cn(
            "w-0 shrink-0 transition-[width] duration-300 ease-in-out",
            showContext && CONTEXT_COLUMN,
          )}
        />

        {hasContext ? (
          <aside
            aria-hidden={!showContext}
            aria-label="Order context"
            className={cn(
              "thin-scrollbar absolute right-4 top-4 max-h-[calc(100%-2rem)] w-72 max-w-[85vw] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-md transition-transform duration-300 ease-in-out",
              showContext
                ? "translate-x-0"
                : "pointer-events-none translate-x-[calc(100%+1rem)]",
            )}
          >
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context
            </h2>
            <dl className="space-y-3 pt-3">
              <Field label="Order" value={detail.orderRef} />
              {resolved ? (
                <Field label="Tracking" value={detail.trackingNumber} />
              ) : (
                <TrackingField
                  escalationId={detail.id}
                  current={detail.trackingNumber}
                />
              )}
              <Field label="Ship to" value={shipTo || null} />
            </dl>
          </aside>
        ) : null}
      </div>

      <div className="thin-scrollbar max-h-[60%] shrink-0 overflow-y-auto border-t border-border/60 bg-card px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          {resolved ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              You&apos;ve responded to this ticket — the support team is handling
              it from here.
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="note">Your update</Label>
                <Textarea
                  id="note"
                  required
                  rows={3}
                  className="min-h-[76px]"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What did you find / do? (e.g. reshipped via DHL, new ETA Friday)"
                />
                <p className="text-xs text-muted-foreground">
                  The support team turns this into a customer reply — write it
                  for them, not the customer.
                </p>
              </div>
              {attachments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {attachments.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs"
                    >
                      <Paperclip className="size-3 shrink-0" aria-hidden />
                      <span className="max-w-[14rem] truncate">
                        {a.filename}
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
              <div className="flex items-end gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="proposedResolution">
                    Suggested resolution (optional)
                  </Label>
                  <Textarea
                    id="proposedResolution"
                    rows={1}
                    className="min-h-9"
                    value={proposedResolution}
                    onChange={(e) => setProposedResolution(e.target.value)}
                    placeholder="e.g. reship, refund, wait 3 days"
                  />
                </div>
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
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                  title="Attach a photo or document (label, invoice, proof of delivery)"
                >
                  <Paperclip aria-hidden />
                  {uploading ? "Uploading…" : "Attach"}
                </Button>
                <Button type="submit" disabled={update.isPending || uploading}>
                  {update.isPending ? "Submitting…" : "Submit update"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
