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
}: {
  readonly message: DashboardConversationMessage;
  readonly workspaceId: string;
  readonly ticketId: string;
}) => {
  const outbound = message.direction === "outbound";
  // An optimistic (not-yet-confirmed) reply pulses and reads "Sending…" until the
  // real message replaces it on refetch (or is rolled back on failure).
  const pending = isOptimisticMessage(message);
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
          {senderLabel(message.from)}
        </span>
        <span>·</span>
        <span className="font-mono">
          {pending ? "Sending…" : formatDateTime(message.sentAt)}
        </span>
      </div>
      <div
        className={cn(
          chatBubbleChromeClass(message),
          pending && "animate-pulse",
        )}
      >
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
}: {
  readonly result: TicketConversationThreadResult;
  readonly workspaceId: string;
  readonly ticketId: string;
}) => {
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
      {result.thread.messages.map((message) => (
        <Bubble
          key={message.id}
          message={message}
          workspaceId={workspaceId}
          ticketId={ticketId}
        />
      ))}
    </div>
  );
};
