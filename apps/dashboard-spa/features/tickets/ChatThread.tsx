import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { Link } from "@/components/ui/link";
import type {
  TicketConversationThreadResult,
  DashboardConversationMessage,
  DashboardConversationParticipant,
} from "@support-agent/dashboard-contracts";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  chatBubbleChromeClass,
  conversationThreadUnavailableView,
} from "@/lib/ticket-timeline";
import { classifyEntrances, type MessageEntrance } from "@/lib/chat-entrance";
import { isOptimisticMessage } from "@/lib/optimistic-reply";
import { MessageAttachments } from "./AttachmentPreview";

const formatDateTime = (date: string): string =>
  date.slice(0, 16).replace("T", " ");

const senderLabel = (p: DashboardConversationParticipant): string =>
  p.name && p.name.length > 0 ? p.name : p.email;

const Bubble = ({
  message,
  workspaceId,
  ticketId,
  entrance,
}: {
  readonly message: DashboardConversationMessage;
  readonly workspaceId: string;
  readonly ticketId: string;
  /** Mount animation — "rise" for new arrivals, "settle" for the confirmed
      reply replacing an optimistic placeholder, undefined for no animation. */
  readonly entrance: MessageEntrance | undefined;
}) => {
  const outbound = message.direction === "outbound";
  // An optimistic (not-yet-confirmed) reply stays translucent and reads
  // "Sending…" until the real message replaces it on refetch (settling to full
  // opacity), or it's rolled back on failure.
  const pending = isOptimisticMessage(message);
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        outbound ? "items-end" : "items-start",
        pending && "opacity-60",
        entrance === "rise" && "msg-rise",
        entrance === "settle" && "msg-settle",
      )}
    >
      <div
        className={cn(
          "flex max-w-[85%] min-w-0 items-center gap-2 px-1 text-[0.6875rem] text-muted-foreground",
          outbound ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className="min-w-0 truncate font-medium text-foreground/70">
          {senderLabel(message.from)}
        </span>
        <span>·</span>
        <span className="font-mono">
          {pending ? "Sending…" : formatDateTime(message.sentAt)}
        </span>
      </div>
      <div className={chatBubbleChromeClass(message)}>
        {message.sanitizedBodyHtml ? (
          <div
            className={cn(
              // Email HTML can carry wide tables / long unbreakable tokens; keep
              // them inside the bubble — wrap what wraps, scroll what can't.
              "email-html max-w-full overflow-x-auto break-words",
              // Links/quotes inside an outbound (primary-colored) bubble need a
              // legible foreground; inbound bubbles use the normal palette.
              outbound && "[&_a]:text-primary-foreground [&_a]:underline",
            )}
            dangerouslySetInnerHTML={{ __html: message.sanitizedBodyHtml }}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words">
            {message.bodyText || "(empty message)"}
          </p>
        )}
        <MessageAttachments
          workspaceId={workspaceId}
          ticketId={ticketId}
          attachments={message.attachments}
          outbound={outbound}
        />
      </div>
    </div>
  );
};

/**
 * The conversation as a chat transcript: customer (inbound) messages on the
 * left, store/agent (outbound) replies on the right. This is the center column
 * of the ticket view — the email thread the ticket is about. Falls back to a clear
 * explanation when the connected mailbox can't return the thread.
 */
export const ChatThread = ({
  result,
  workspaceId,
  ticketId,
  processing,
  resolved,
}: {
  readonly result: TicketConversationThreadResult;
  readonly workspaceId: string;
  readonly ticketId: string;
  /** True while the agent is actively working — shows the in-thread
      "Agent is working" indicator at the end of the transcript. */
  readonly processing: boolean;
  /** True when the ticket is resolved — shows the green banner closing the
      thread. It animates in only when the flip happens live on this page. */
  readonly resolved: boolean;
}) => {
  const messages =
    result.status === "available" ? result.thread.messages : [];

  // Entrance classification: compare this render's message ids against the
  // previous render's. Memoized on the id list so re-renders that don't change
  // the thread reuse the same map — a bubble's mount animation class is never
  // recomputed away mid-flight. The initial render classifies nothing, so
  // opening a ticket doesn't animate the whole backlog.
  const idsKey = messages.map((m) => m.id).join("\n");
  const prevIdsRef = useRef<ReadonlyArray<string> | null>(null);
  // idsKey (not `messages`) is deliberately the dependency: it's the identity
  // that matters, and it keeps object-identity churn from reclassifying.
  const entrances = useMemo(
    () => classifyEntrances(prevIdsRef.current, messages),
    [idsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    prevIdsRef.current = messages.map((m) => m.id);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The resolved banner only animates when the flip happens while the page is
  // open; a ticket loaded already-resolved renders it statically. Once armed
  // it stays armed, so later re-renders can't strip the class mid-animation.
  const [resolvedLive, setResolvedLive] = useState(false);
  const prevResolvedRef = useRef(resolved);
  useEffect(() => {
    if (!prevResolvedRef.current && resolved) setResolvedLive(true);
    prevResolvedRef.current = resolved;
  }, [resolved]);

  if (result.status === "unavailable") {
    const view = conversationThreadUnavailableView(result.reason);
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-sm space-y-2 text-center">
          <div className="text-sm font-medium">{view.title}</div>
          <p className="text-sm text-muted-foreground">{view.description}</p>
          {view.showIntegrationsLink ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/integrations">Open integrations</Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (result.thread.messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          No messages in this conversation yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {messages.map((message) => (
        <Bubble
          key={message.id}
          message={message}
          workspaceId={workspaceId}
          ticketId={ticketId}
          entrance={entrances.get(message.id)}
        />
      ))}
      {processing ? (
        <div
          role="status"
          className="msg-rise flex items-center gap-2 px-1 text-xs font-semibold text-primary"
        >
          <Sparkles className="size-3.5" aria-hidden />
          Agent is working
          <span className="inline-flex items-center gap-1" aria-hidden>
            <span className="typing-dot size-1 rounded-full bg-primary" />
            <span className="typing-dot size-1 rounded-full bg-primary" />
            <span className="typing-dot size-1 rounded-full bg-primary" />
          </span>
        </div>
      ) : null}
      {resolved ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm font-medium text-success",
            resolvedLive && "resolved-pop",
          )}
        >
          <Check className="size-4" strokeWidth={3} aria-hidden />
          Ticket resolved
        </div>
      ) : null}
    </div>
  );
};
