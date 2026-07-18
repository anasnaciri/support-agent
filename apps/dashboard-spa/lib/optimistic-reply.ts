import type {
  DashboardConversationMessage,
  DashboardConversationThread,
} from "@support-agent/dashboard-contracts";

// Optimistic outbound replies are pinned into page state the moment the
// manager hits Send (lib/pinned-replies.ts), so the bubble shows immediately
// — translucent — instead of waiting for the round-trip. The id prefix is the
// marker the chat thread reads to render the "sending…" state; on confirmation
// the pin swaps to the real provider message id (or is dropped if the send
// fails).
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
