import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Loader2, Paperclip, X } from "lucide-react";
import type { DashboardConversationAttachment } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { attachmentPreviewKind } from "@/lib/attachment-preview";
import { formatAttachmentSize } from "@/lib/ticket-timeline";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Signed preview URLs expire in 5 minutes (ATTACHMENT_URL_TTL_SECONDS). We
// re-mint well inside that so a thumbnail sitting on screen never 403s, and we
// never persist one to disk/cache.
const URL_STALE_MS = 3 * 60 * 1000;

const useAttachmentUrl = (
  workspaceId: string,
  ticketId: string,
  attachmentId: string | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: ["attachment-url", workspaceId, ticketId, attachmentId],
    queryFn: () =>
      api.ticketAttachmentUrl({ workspaceId }, ticketId, attachmentId!),
    enabled: enabled && Boolean(attachmentId),
    staleTime: URL_STALE_MS,
    gcTime: URL_STALE_MS,
    retry: false,
  });

/** Full-screen viewer for one image. Closes on backdrop click or Escape. */
function Lightbox({
  url,
  filename,
  onClose,
}: {
  readonly url: string;
  readonly filename: string;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-md p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="size-5" aria-hidden />
      </button>
      <img
        src={url}
        alt={filename}
        // The backdrop closes; the image itself should not.
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90dvh] max-w-full rounded-lg object-contain shadow-2xl"
      />
    </div>
  );
}

function ImageAttachment({
  workspaceId,
  ticketId,
  attachment,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly attachment: DashboardConversationAttachment;
}) {
  const [open, setOpen] = useState(false);
  const q = useAttachmentUrl(workspaceId, ticketId, attachment.id, true);

  if (q.isError) {
    // A dead blob or a revoked credential must not blank the message.
    return <InertAttachment attachment={attachment} />;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!q.data}
        title={`${attachment.filename} · ${formatAttachmentSize(attachment.sizeBytes)}`}
        className="group relative block size-24 overflow-hidden rounded-md border border-border bg-muted/40 transition-opacity hover:opacity-90 disabled:cursor-default"
      >
        {q.data ? (
          <img
            src={q.data.url}
            alt={attachment.filename}
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </span>
        )}
      </button>
      {open && q.data ? (
        <Lightbox
          url={q.data.url}
          filename={attachment.filename}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function FileAttachment({
  workspaceId,
  ticketId,
  attachment,
  outbound,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly attachment: DashboardConversationAttachment;
  readonly outbound: boolean;
}) {
  // Only mint the URL when the manager asks for the file — a thread full of
  // PDFs shouldn't sign a URL for each on render.
  const [wanted, setWanted] = useState(false);
  const q = useAttachmentUrl(workspaceId, ticketId, attachment.id, wanted);

  useEffect(() => {
    if (q.data?.url) {
      window.open(q.data.url, "_blank", "noopener,noreferrer");
      setWanted(false);
    }
  }, [q.data?.url]);

  return (
    <button
      type="button"
      onClick={() => setWanted(true)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted",
        outbound &&
          "border-bubble-foreground/40 text-bubble-foreground hover:bg-bubble-foreground/10",
      )}
      title="Open this file"
    >
      {q.isFetching ? (
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <FileText className="size-3 shrink-0" aria-hidden />
      )}
      <span className="max-w-[14rem] truncate">{attachment.filename}</span>
      <span className="opacity-70">
        {formatAttachmentSize(attachment.sizeBytes)}
      </span>
      <Download className="size-3 shrink-0 opacity-70" aria-hidden />
    </button>
  );
}

/** Metadata only — the connector named a file whose bytes we never stored. */
function InertAttachment({
  attachment,
}: {
  readonly attachment: DashboardConversationAttachment;
}) {
  return (
    <Badge variant="outline" className="font-normal">
      <Paperclip className="mr-1 size-3" aria-hidden />
      {attachment.filename} · {formatAttachmentSize(attachment.sizeBytes)}
    </Badge>
  );
}

/**
 * The attachments carried by one message. Images become thumbnails that open a
 * lightbox; other stored files open through a short-lived signed URL; anything
 * we hold no bytes for stays an inert badge.
 */
export function MessageAttachments({
  workspaceId,
  ticketId,
  attachments,
  outbound,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly attachments: ReadonlyArray<DashboardConversationAttachment>;
  readonly outbound: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {attachments.map((attachment, index) => {
        const key = `${attachment.id ?? "inert"}-${index}`;
        const kind = attachmentPreviewKind(attachment);
        if (kind === "image") {
          return (
            <ImageAttachment
              key={key}
              workspaceId={workspaceId}
              ticketId={ticketId}
              attachment={attachment}
            />
          );
        }
        if (kind === "file") {
          return (
            <FileAttachment
              key={key}
              workspaceId={workspaceId}
              ticketId={ticketId}
              attachment={attachment}
              outbound={outbound}
            />
          );
        }
        return <InertAttachment key={key} attachment={attachment} />;
      })}
    </div>
  );
}
