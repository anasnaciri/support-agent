import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApprovalDetail,
  TicketAttachmentSummary,
} from "@support-agent/dashboard-contracts";
import { Files, Layers, Paperclip, X } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useApprovalDecision, useBundleDecision } from "@/lib/use-ticket-mutation";
import {
  attachmentPickerState,
  attachmentSourceLabel,
} from "@/lib/attachment-picker";
import { toolActionLabel } from "@/lib/labels";
import { formatAttachmentSize } from "@/lib/ticket-timeline";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton } from "./ConfirmButton";

/**
 * Bundle approval control (autonomous loop). When the scenario agent queues
 * several gated actions on one ticket, the operator can approve them all at once
 * ("Approve all" / "Reject remaining" via the ticket-scoped bundle endpoint) OR
 * accept them one at a time (the per-row single-approval endpoint). Accepting
 * one runs THAT action now; the ticket stays parked until every action is decided.
 * Rendered only when there's more than one pending approval.
 */
interface Props {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly pending: ReadonlyArray<ApprovalDetail>;
}

const MONEY_TOOLS: ReadonlySet<string> = new Set([
  "refund.create",
  "discount.create",
  "order.cancel",
]);
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

const replyBodyText = (approval: ApprovalDetail): string => {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  return proposed && typeof proposed["bodyText"] === "string"
    ? (proposed["bodyText"] as string)
    : "";
};

const replyAttachmentIds = (proposed: Record<string, unknown> | null) =>
  Array.isArray(proposed?.["attachmentIds"])
    ? proposed["attachmentIds"].filter((x): x is string => typeof x === "string")
    : [];

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

function BundleRow({
  workspaceId,
  ticketId,
  approval,
  onReplyInputChange,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly approval: ApprovalDetail;
  readonly onReplyInputChange: (approvalId: string, input: unknown) => void;
}) {
  const isReply = approval.tool === "conversation.reply";
  const [bodyText, setBodyText] = useState(() => replyBodyText(approval));
  const [attachments, setAttachments] = useState<TicketAttachmentSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const ctx = { workspaceId };
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  const indexQ = useQuery({
    queryKey: qk.ticketAttachments(workspaceId, ticketId),
    queryFn: () => api.ticketAttachments(ctx, ticketId),
    enabled: isReply,
  });
  const existingAttachmentIds = useMemo(
    () => replyAttachmentIds(proposed),
    [proposed],
  );
  const mergedAttachmentIds = useMemo(
    () => [
      ...new Set([...existingAttachmentIds, ...attachments.map((a) => a.id)]),
    ],
    [attachments, existingAttachmentIds],
  );
  const approvedInput = useMemo(
    () =>
      isReply && proposed
        ? {
            ...proposed,
            bodyText,
            ...(mergedAttachmentIds.length > 0
              ? { attachmentIds: mergedAttachmentIds }
              : {}),
          }
        : undefined,
    [bodyText, isReply, mergedAttachmentIds, proposed],
  );
  const picker = attachmentPickerState({
    index: indexQ.data?.attachments ?? [],
    staged: attachments,
    max: MAX_ATTACHMENTS,
  });

  useEffect(() => {
    if (isReply && proposed) {
      onReplyInputChange(approval.id, approvedInput);
    }
  }, [approval.id, approvedInput, isReply, onReplyInputChange, proposed]);

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
      void qc.invalidateQueries({
        queryKey: qk.ticketAttachments(workspaceId, ticketId),
      });
    } catch {
      setError(uploadErrorText("failed"));
    } finally {
      setUploading(false);
    }
  };

  const acceptM = useApprovalDecision({
    workspaceId,
    ticketId,
    action: "approve",
    mutationFn: () => api.approveApproval({ workspaceId }, approval.id, approvedInput),
  });

  return (
    <li className="space-y-2">
      <div className="text-sm font-medium">{toolActionLabel(approval.tool)}</div>
      {isReply ? (
        <div className="space-y-2">
          <Label htmlFor={`reply-${approval.id}`}>Customer reply</Label>
          <Textarea
            id={`reply-${approval.id}`}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={5}
          />
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
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
          <div className="flex flex-wrap items-center gap-1">
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
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
      {MONEY_TOOLS.has(approval.tool) ? (
        <ConfirmButton
          variant="secondary"
          title={`Accept "${toolActionLabel(approval.tool)}" now?`}
          description="This action runs now and may move money. The ticket stays open until the other queued actions are decided."
          confirmLabel="Accept"
          pending={acceptM.isPending}
          onConfirm={() => acceptM.mutate()}
        >
          Accept
        </ConfirmButton>
      ) : (
        <Button
          variant="secondary"
          onClick={() => acceptM.mutate()}
          disabled={acceptM.isPending}
        >
          {acceptM.isPending ? "Accepting…" : "Accept"}
        </Button>
      )}
    </li>
  );
}

export function BundleApprovalBar({ workspaceId, ticketId, pending }: Props) {
  const [replyEdits, setReplyEdits] = useState<Record<string, unknown>>({});
  const recordReplyEdit = useCallback((approvalId: string, input: unknown) => {
    setReplyEdits((prev) =>
      prev[approvalId] === input ? prev : { ...prev, [approvalId]: input },
    );
  }, []);
  const approveAllM = useBundleDecision({
    workspaceId,
    ticketId,
    action: "approve",
    mutationFn: () =>
      api.approveTicketBundle(
        { workspaceId },
        ticketId,
        Object.keys(replyEdits).length > 0 ? replyEdits : undefined,
      ),
  });
  const rejectAllM = useBundleDecision({
    workspaceId,
    ticketId,
    action: "reject",
    mutationFn: () => api.rejectTicketBundle({ workspaceId }, ticketId),
  });

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="size-4 text-primary" aria-hidden />
          <span>{pending.length} actions are queued for your approval</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Approve them all at once, or accept them one at a time. The ticket stays
          open until every action is decided.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <ConfirmButton
            variant="default"
            title={`Approve all ${pending.length} actions?`}
            description="Each queued action runs in order. Anything that moves money (a refund) executes against Shopify, and the customer reply is sent. This can't be undone from here."
            confirmLabel="Approve all"
            pending={approveAllM.isPending}
            onConfirm={() => approveAllM.mutate()}
          >
            Approve all
          </ConfirmButton>
          <ConfirmButton
            variant="outline"
            title="Reject the remaining actions?"
            description="The actions you haven't accepted won't run, and the ticket moves to human takeover for you to handle. Anything you already accepted stays done."
            confirmLabel="Reject remaining"
            pending={rejectAllM.isPending}
            onConfirm={() => rejectAllM.mutate()}
          >
            Reject remaining
          </ConfirmButton>
        </div>

        <Separator />

        <ul className="space-y-4">
          {pending.map((a) => (
            <BundleRow
              key={a.id}
              workspaceId={workspaceId}
              ticketId={ticketId}
              approval={a}
              onReplyInputChange={recordReplyEdit}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
