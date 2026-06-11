import { Effect } from "effect";
import sanitizeHtml from "sanitize-html";
import type {
  ConversationError,
  ConversationThread,
} from "@support-agent/agent-core";
import type {
  CaseConversationThreadUnavailableReason,
  DashboardConversationThread,
} from "@support-agent/dashboard-contracts";
import type {
  ConnectorConnection,
  ConversationProviderId,
} from "@support-agent/services";
import { isConversationProvider } from "@support-agent/services";

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
    exclusiveFilter: ({ tag, attribs }) => {
      const classes = (attribs["class"] ?? "").toLowerCase().split(/\s+/);
      const id = (attribs["id"] ?? "").toLowerCase();
      return (
        classes.some((name) =>
          ["gmail_quote", "gmail_extra", "yahoo_quoted", "protonmail_quote"].includes(
            name,
          ),
        ) ||
        id === "divrplyfwdmsg" ||
        (tag === "blockquote" && attribs["type"]?.toLowerCase() === "cite")
      );
    },
  });

export const stripQuotedText = (text: string): string => {
  const markers = [
    /\nOn [^\n]+wrote:\s*\n/iu,
    /\n-{2,}\s*Original Message\s*-{2,}\s*\n/iu,
  ];
  let cutAt = text.length;
  for (const marker of markers) {
    const index = text.search(marker);
    if (index >= 0 && index < cutAt) cutAt = index;
  }
  const lines = text.slice(0, cutAt).split("\n");
  while (
    lines.length > 0 &&
    (lines.at(-1)?.trim() === "" || lines.at(-1)?.trimStart().startsWith(">"))
  ) {
    lines.pop();
  }
  return lines.join("\n").trim();
};

export const projectConversationThread = (
  thread: ConversationThread,
): DashboardConversationThread => {
  const seenMessageIds = new Set<string>();
  return {
    subject: thread.subject,
    participants: thread.participants.map(({ name, email }) => ({ name, email })),
    messages: thread.messages.flatMap((message) => {
      if (seenMessageIds.has(message.id)) return [];
      seenMessageIds.add(message.id);
      return [
        {
          id: message.id,
          direction: message.direction,
          from: { name: message.from.name, email: message.from.email },
          to: message.to.map(({ name, email }) => ({ name, email })),
          subject: message.subject,
          bodyText: stripQuotedText(message.bodyText),
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
        },
      ];
    }),
  };
};

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

export const resolveCaseConversationMailbox = (
  caseMailbox: string | null,
  provider: ConversationProviderId,
  connections: ReadonlyArray<ConnectorConnection>,
):
  | { readonly ok: true; readonly mailbox: string }
  | {
      readonly ok: false;
      readonly reason: "auth_required" | "mailbox_ambiguous";
    } => {
  if (caseMailbox) return { ok: true, mailbox: caseMailbox };
  const candidates = connections.filter(
    (connection) =>
      connection.provider === provider && connection.status === "active",
  );
  if (candidates.length === 1) {
    return { ok: true, mailbox: candidates[0]!.shopDomain };
  }
  return {
    ok: false,
    reason: candidates.length === 0 ? "auth_required" : "mailbox_ambiguous",
  };
};

export const resolveCaseConversationThread = (
  caseMailbox: string | null,
  provider: ConversationProviderId | null,
  connections: ReadonlyArray<ConnectorConnection>,
  fetchThread: (
    provider: ConversationProviderId,
    mailbox: string,
  ) => Effect.Effect<ConversationThread, ConversationError>,
): Effect.Effect<
  | {
      readonly ok: true;
      readonly mailbox: string;
      readonly thread: ConversationThread;
    }
  | {
      readonly ok: false;
      readonly reason: "auth_required" | "mailbox_ambiguous";
    }
> =>
  Effect.gen(function* () {
    const activeConnections = connections.filter(
      (connection) =>
        connection.status === "active" &&
        isConversationProvider(connection.provider) &&
        (provider === null || connection.provider === provider),
    );

    const probe = (
      candidateProvider: ConversationProviderId,
      mailbox: string,
    ) =>
      fetchThread(candidateProvider, mailbox).pipe(
        Effect.match({
          onFailure: (error) =>
            error._tag === "ConversationAuthMissing" ||
            error._tag === "ConversationAuthFailed"
              ? ({ ok: false as const, reason: "auth_required" as const })
              : null,
          onSuccess: (
            thread,
          ): {
            readonly ok: true;
            readonly mailbox: string;
            readonly thread: ConversationThread;
          } => ({
            ok: true,
            mailbox,
            thread,
          }),
        }),
      );

    const candidateProviders =
      provider === null
        ? Array.from(
            new Set(
              activeConnections
                .map((connection) => connection.provider)
                .filter(isConversationProvider),
            ),
          )
        : [provider];

    if (caseMailbox && provider !== null) {
      const result = yield* probe(provider, caseMailbox);
      if (result?.ok) return result;
      if (result?.reason === "auth_required") return result;
    }

    if (activeConnections.length === 0) {
      return { ok: false as const, reason: "auth_required" as const };
    }

    let sawAuthRequired = false;
    for (const candidateProvider of candidateProviders) {
      for (const connection of activeConnections) {
        const result = yield* probe(candidateProvider, connection.shopDomain);
        if (result?.ok) return result;
        if (result?.reason === "auth_required") sawAuthRequired = true;
      }
    }

    return {
      ok: false as const,
      reason: sawAuthRequired ? ("auth_required" as const) : ("mailbox_ambiguous" as const),
    };
  });
