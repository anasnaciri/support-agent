import sanitizeHtml from "sanitize-html";
import type {
  ConversationError,
  ConversationThread,
} from "@support-agent/agent-core";
import type {
  CaseConversationThreadUnavailableReason,
  DashboardConversationThread,
} from "@support-agent/dashboard-contracts";

const SAFE_EMAIL_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

export const sanitizeEmailHtml = (html: string): string =>
  sanitizeHtml(html, {
    allowedTags: [...SAFE_EMAIL_TAGS],
    allowedAttributes: { a: ["href"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
  });

export const projectConversationThread = (
  thread: ConversationThread,
): DashboardConversationThread => ({
  subject: thread.subject,
  participants: thread.participants.map(({ name, email }) => ({ name, email })),
  messages: thread.messages.map((message) => ({
    id: message.id,
    direction: message.direction,
    from: { name: message.from.name, email: message.from.email },
    to: message.to.map(({ name, email }) => ({ name, email })),
    subject: message.subject,
    bodyText: message.bodyText,
    sanitizedBodyHtml: message.bodyHtml
      ? sanitizeEmailHtml(message.bodyHtml)
      : null,
    sentAt: message.sentAt.toISOString(),
    attachments: message.attachments.map(
      ({ filename, contentType, sizeBytes }) => ({
        filename,
        contentType,
        sizeBytes,
      }),
    ),
  })),
});

export const conversationUnavailableReason = (
  error: ConversationError,
): Exclude<CaseConversationThreadUnavailableReason, "no_thread"> => {
  switch (error._tag) {
    case "ThreadNotFound":
      return "thread_not_found";
    case "ConversationAuthMissing":
    case "ConversationAuthFailed":
      return "auth_required";
    case "ConversationProviderUnavailable":
    case "ConversationSendFailed":
      return "provider_unavailable";
  }
};
