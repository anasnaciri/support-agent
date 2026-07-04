import { Effect } from "effect";
import sanitizeHtml from "sanitize-html";
import type {
  ConversationError,
  ConversationThread,
} from "@support-agent/agent-core";
import type {
  TicketConversationThreadUnavailableReason,
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

// Inline-style allowlist. Each value regex rejects `url(...)`, `expression(...)`,
// and `javascript:` by construction (the patterns admit only colors, lengths,
// keywords, and font names — never parentheses with a payload), so a remote
// load or script can't ride in through a style declaration. Properties absent
// from this map (e.g. `position`, `background`, `content`) are dropped entirely.
const LEN =
  String.raw`(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt|ex|vh|vw|vmin|vmax|ch))`;
const LENGTH = new RegExp(`^${LEN}(?:\\s+${LEN}){0,3}$`, "iu");
const COLOR =
  /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.,%\s]+\)|hsla?\(\s*[\d.,%\s]+\)|[a-z]+)$/iu;
const FONT_FAMILY = /^[\w\s,"'.-]+$/u;
// border shorthands: widths, named styles, hex colors — no parens → no url().
const BORDER = /^[\w\s#.%,-]+$/u;

const SAFE_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": {
    color: [COLOR],
    "background-color": [COLOR],
    // `background` shorthand restricted to a colour — COLOR rejects `url(...)`,
    // so button fills survive but background images/tracking can't ride in.
    background: [COLOR],
    "font-family": [FONT_FAMILY],
    "font-size": [LENGTH],
    "font-weight": [/^(?:normal|bold|bolder|lighter|[1-9]00)$/iu],
    "font-style": [/^(?:normal|italic|oblique)$/iu],
    "line-height": [/^(?:normal|\d+(?:\.\d+)?|[\d.]+(?:px|em|rem|%|pt))$/iu],
    "letter-spacing": [LENGTH],
    "text-align": [/^(?:left|right|center|justify|start|end)$/iu],
    "text-decoration": [/^[a-z\s-]+$/iu],
    "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/iu],
    "vertical-align": [
      /^(?:baseline|top|middle|bottom|sub|super|text-top|text-bottom)$/iu,
      LENGTH,
    ],
    display: [
      /^(?:block|inline|inline-block|none|table|table-row|table-cell|list-item|flex)$/iu,
    ],
    width: [LENGTH],
    "max-width": [LENGTH],
    "min-width": [LENGTH],
    height: [LENGTH],
    "max-height": [LENGTH],
    padding: [LENGTH],
    "padding-top": [LENGTH],
    "padding-right": [LENGTH],
    "padding-bottom": [LENGTH],
    "padding-left": [LENGTH],
    margin: [LENGTH],
    "margin-top": [LENGTH],
    "margin-right": [LENGTH],
    "margin-bottom": [LENGTH],
    "margin-left": [LENGTH],
    border: [BORDER],
    "border-top": [BORDER],
    "border-right": [BORDER],
    "border-bottom": [BORDER],
    "border-left": [BORDER],
    "border-color": [COLOR],
    "border-width": [LENGTH],
    "border-style": [
      /^(?:none|solid|dashed|dotted|double|groove|ridge|inset|outset)$/iu,
    ],
    "border-radius": [LENGTH],
  },
};

export const sanitizeEmailHtml = (html: string): string =>
  sanitizeHtml(html, {
    allowedTags: [...SAFE_EMAIL_TAGS],
    // Keep `style` everywhere (filtered by SAFE_STYLES) plus the presentational
    // attributes table-based email layouts depend on — none of which can load a
    // remote resource or execute script.
    allowedAttributes: {
      // `class`/`id`/`type` are inert (no stylesheet survives) but the
      // quoted-reply `exclusiveFilter` below keys off them, so they must reach
      // it post-attribute-filtering.
      "*": ["style", "class", "id"],
      a: ["href"],
      blockquote: ["type"],
      table: ["width", "align", "bgcolor", "cellpadding", "cellspacing", "border"],
      td: ["width", "height", "align", "valign", "bgcolor", "colspan", "rowspan"],
      th: ["width", "height", "align", "valign", "bgcolor", "colspan", "rowspan"],
      tr: ["align", "valign", "bgcolor", "height"],
    },
    allowedStyles: SAFE_STYLES,
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

// Zero-width / formatting characters marketing mail packs into the plain-text
// part as invisible preheader spacers. Left in, they render as stray gaps in
// the dashboard's plain-text fallback (the body shows whitespace-pre-wrap).
const INVISIBLE_CHARS = /[­͏​-‏⁠﻿᠎]/gu;

/** Drop invisible spacer characters and the blank lines they leave behind. */
export const cleanPlainTextBody = (text: string): string =>
  text
    .replace(INVISIBLE_CHARS, "")
    .replace(/ /gu, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");

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
          bodyText: stripQuotedText(cleanPlainTextBody(message.bodyText)),
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
): Exclude<TicketConversationThreadUnavailableReason, "no_thread"> => {
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

export const resolveTicketConversationMailbox = (
  ticketMailbox: string | null,
  provider: ConversationProviderId,
  connections: ReadonlyArray<ConnectorConnection>,
):
  | { readonly ok: true; readonly mailbox: string }
  | {
      readonly ok: false;
      readonly reason: "auth_required" | "mailbox_ambiguous";
    } => {
  if (ticketMailbox) return { ok: true, mailbox: ticketMailbox };
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

export const resolveTicketConversationThread = (
  ticketMailbox: string | null,
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

    if (ticketMailbox && provider !== null) {
      const result = yield* probe(provider, ticketMailbox);
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
