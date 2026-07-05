import type {
  DashboardConversationMessage,
  DashboardConversationThread,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

// Optimistic outbound replies are stamped into the thread query cache the moment
// the manager hits Send, so the bubble shows immediately (pulsing) instead of
// waiting for the round-trip. The id prefix is the marker the chat thread reads
// to render the "sending…" state; the real message replaces it once the ticket
// refetches (or the optimistic one is rolled back if the send fails).
export const OPTIMISTIC_MESSAGE_ID_PREFIX = "optimistic:";

export const isOptimisticMessage = (message: {
  readonly id: string;
}): boolean => message.id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX);

// Build the placeholder outbound message. The sender mirrors the thread's most
// recent outbound message (so it reads as "us"); when the thread has none yet we
// fall back to a neutral "You" label.
export const buildOptimisticOutboundMessage = (args: {
  readonly id: string;
  readonly bodyText: string;
  readonly customerEmail: string | null;
  readonly thread: DashboardConversationThread | null;
  readonly sentAt: string;
}): DashboardConversationMessage => {
  const lastOutboundFrom = args.thread?.messages
    .filter((m) => m.direction === "outbound")
    .at(-1)?.from;
  return {
    id: args.id,
    direction: "outbound",
    from: lastOutboundFrom ?? { name: "You", email: "" },
    to: args.customerEmail ? [{ name: null, email: args.customerEmail }] : [],
    subject: args.thread?.subject ?? null,
    bodyText: args.bodyText,
    sanitizedBodyHtml: null,
    sentAt: args.sentAt,
    attachments: [],
  };
};

// Append the optimistic message to the cached thread. Only "available" threads
// have a message list to grow; anything else (no thread yet, provider error) is
// returned untouched so the send still proceeds without a placeholder bubble.
export const appendOptimisticReply = (
  result: TicketConversationThreadResult | undefined,
  message: DashboardConversationMessage,
): TicketConversationThreadResult | undefined => {
  if (!result || result.status !== "available") return result;
  return {
    status: "available",
    thread: {
      ...result.thread,
      messages: [...result.thread.messages, message],
    },
  };
};
