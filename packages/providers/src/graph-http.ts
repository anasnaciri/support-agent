// ============================================================
// Microsoft Graph mail HTTP — low-level wire format
// ============================================================
//
// Plain async functions over `fetch` (no Effect Tag — the Live
// ConversationService wraps these), mirroring `gmail-http.ts`. We use only a
// handful of Graph endpoints, so we hand-roll HTTP instead of pulling the
// `@microsoft/microsoft-graph-client` SDK; that keeps the package small and
// unit-testable against a mocked fetch.
//
// Threading model: Graph groups mail by `conversationId`, which we map onto
// our `ThreadId`. Replies go through `createReply` → PATCH body → `send` so
// the message stays in the same conversation AND we get back a provider id
// for the sent message (a bare `/reply` returns 202 with no body).

import type {
  ConversationMessage,
  ConversationThread,
  MessageParticipant,
  ThreadId,
} from "@support-agent/agent-core";
import { ThreadId as makeThreadId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export type GraphHttpFailure =
  | { readonly kind: "auth_failed"; readonly status: number }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "not_found"; readonly status: number }
  | { readonly kind: "network"; readonly status: number; readonly body: string };

export class GraphHttpError extends Error {
  readonly failure: GraphHttpFailure;
  constructor(failure: GraphHttpFailure, message: string) {
    super(message);
    this.failure = failure;
    this.name = "GraphHttpError";
  }
}

// ============================================================
// Internal fetch wrapper
// ============================================================

interface GraphFetchOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  /** Value for the `Prefer` header (e.g. text-body content type). */
  readonly prefer?: string;
  readonly fetchImpl?: typeof fetch;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const graphFetch = async (opts: GraphFetchOptions): Promise<unknown> => {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const init: Parameters<typeof fetch>[1] = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await f(`${GRAPH_BASE}${opts.path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new GraphHttpError(
        { kind: "auth_failed", status: res.status },
        `graph ${opts.path}: ${res.status}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      throw new GraphHttpError(
        { kind: "rate_limited", retryAfterMs: retryAfter * 1000 },
        `graph ${opts.path}: 429`,
      );
    }
    if (res.status === 404) {
      throw new GraphHttpError(
        { kind: "not_found", status: 404 },
        `graph ${opts.path}: 404`,
      );
    }
    throw new GraphHttpError(
      { kind: "network", status: res.status, body: text },
      `graph ${opts.path}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  // `send` (202) and `PATCH` (200/204) may carry no body.
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  return text ? (JSON.parse(text) as unknown) : null;
};

// ============================================================
// Wire types — only the bits we read
// ============================================================

interface RawEmailAddress {
  readonly name?: string;
  readonly address?: string;
}
interface RawRecipient {
  readonly emailAddress?: RawEmailAddress;
}
interface RawGraphMessage {
  readonly id: string;
  readonly conversationId?: string;
  readonly subject?: string | null;
  readonly from?: RawRecipient;
  readonly sender?: RawRecipient;
  readonly toRecipients?: ReadonlyArray<RawRecipient>;
  readonly body?: { readonly contentType?: string; readonly content?: string };
  readonly receivedDateTime?: string;
  readonly sentDateTime?: string;
  readonly internetMessageId?: string;
  readonly isDraft?: boolean;
}
interface RawMessageList {
  readonly value?: ReadonlyArray<RawGraphMessage>;
}

// ============================================================
// Normalisation
// ============================================================

const toParticipant = (r?: RawRecipient): MessageParticipant => ({
  name: r?.emailAddress?.name ?? null,
  email: r?.emailAddress?.address ?? "",
});

/**
 * Normalise one Graph message into a provider-neutral `ConversationMessage`.
 * `mailbox` is the connected account's address — used to decide direction
 * (Graph messages don't carry one). Body is requested as text via the
 * `Prefer` header, so `bodyHtml` is left null here.
 */
const normaliseMessage = (
  raw: RawGraphMessage,
  threadId: ThreadId,
  mailbox: string,
): ConversationThread["messages"][number] => {
  const from = toParticipant(raw.from ?? raw.sender);
  const isHtml = (raw.body?.contentType ?? "").toLowerCase() === "html";
  const content = raw.body?.content ?? "";
  const sentAtStr = raw.sentDateTime ?? raw.receivedDateTime ?? null;
  return {
    id: raw.id,
    threadId,
    direction:
      from.email.toLowerCase() === mailbox.toLowerCase() ? "outbound" : "inbound",
    from,
    to: (raw.toRecipients ?? []).map(toParticipant),
    subject: raw.subject ?? null,
    bodyText: isHtml ? content.replace(/<[^>]+>/g, " ").trim() : content,
    bodyHtml: isHtml ? content : null,
    sentAt: sentAtStr ? new Date(sentAtStr) : new Date(0),
    attachments: [],
  };
};

const buildThread = (
  raw: RawMessageList,
  conversationId: string,
  mailbox: string,
): ConversationThread => {
  const threadId = makeThreadId(conversationId);
  const messages = (raw.value ?? [])
    .map((m) => normaliseMessage(m, threadId, mailbox))
    // Graph filter + orderby on different fields is restricted, so we sort
    // client-side oldest → newest.
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const subject = messages[0]?.subject ?? "(no subject)";
  const seen = new Set<string>();
  const participants: Array<MessageParticipant> = [];
  for (const msg of messages) {
    for (const p of [msg.from, ...msg.to]) {
      if (!p.email) continue;
      const key = p.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push(p);
    }
  }
  return { id: threadId, subject, participants, messages };
};

// ============================================================
// Public helpers
// ============================================================

export interface GraphHttpCallOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

const MESSAGE_SELECT =
  "id,conversationId,subject,from,sender,toRecipients,body,receivedDateTime,sentDateTime,internetMessageId,isDraft";

/**
 * Fetch every message in a conversation, normalised oldest → newest. `mailbox`
 * is the connected account address (for direction). Returns a thread with an
 * empty `messages` array if the conversation is unknown.
 */
export const graphGetConversation = async (
  opts: GraphHttpCallOptions & {
    readonly conversationId: string;
    readonly mailbox: string;
  },
): Promise<ConversationThread> => {
  const filter = `conversationId eq '${opts.conversationId.replace(/'/g, "''")}'`;
  const path =
    `/me/messages?$filter=${encodeURIComponent(filter)}` +
    `&$select=${encodeURIComponent(MESSAGE_SELECT)}&$top=50`;
  const raw = (await graphFetch({
    path,
    token: opts.token,
    prefer: 'outlook.body-content-type="text"',
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawMessageList;
  return buildThread(raw, opts.conversationId, opts.mailbox);
};

/** Create a reply draft on a message; returns the new draft's id. */
export const graphCreateReplyDraft = async (
  opts: GraphHttpCallOptions & { readonly messageId: string },
): Promise<{ readonly id: string }> => {
  const raw = (await graphFetch({
    method: "POST",
    path: `/me/messages/${encodeURIComponent(opts.messageId)}/createReply`,
    token: opts.token,
    body: {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawGraphMessage;
  return { id: raw.id };
};

/** Replace a reply draft's body and recipients with the approved values. */
export const graphUpdateDraftBody = async (
  opts: GraphHttpCallOptions & {
    readonly draftId: string;
    readonly bodyText: string;
    readonly bodyHtml: string | null;
    readonly to: ReadonlyArray<MessageParticipant>;
  },
): Promise<void> => {
  const content = opts.bodyHtml ?? opts.bodyText;
  const contentType = opts.bodyHtml ? "HTML" : "Text";
  await graphFetch({
    method: "PATCH",
    path: `/me/messages/${encodeURIComponent(opts.draftId)}`,
    token: opts.token,
    body: {
      body: { contentType, content },
      toRecipients: opts.to.map((recipient) => ({
        emailAddress: {
          ...(recipient.name ? { name: recipient.name } : {}),
          address: recipient.email,
        },
      })),
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
};

/** Send a previously-created draft. */
export const graphSendDraft = async (
  opts: GraphHttpCallOptions & { readonly draftId: string },
): Promise<void> => {
  await graphFetch({
    method: "POST",
    path: `/me/messages/${encodeURIComponent(opts.draftId)}/send`,
    token: opts.token,
    body: {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
};

/**
 * Fetch a single message (used by the inbound webhook, which receives only a
 * message id in the change notification). `mailbox` decides direction.
 */
export const graphGetMessage = async (
  opts: GraphHttpCallOptions & {
    readonly messageId: string;
    readonly mailbox: string;
  },
): Promise<ConversationMessage> => {
  const path = `/me/messages/${encodeURIComponent(opts.messageId)}?$select=${encodeURIComponent(
    MESSAGE_SELECT,
  )}`;
  const raw = (await graphFetch({
    path,
    token: opts.token,
    prefer: 'outlook.body-content-type="text"',
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawGraphMessage;
  const conversationId = raw.conversationId ?? opts.messageId;
  return normaliseMessage(raw, makeThreadId(conversationId), opts.mailbox);
};

// ============================================================
// Change-notification subscriptions
// ============================================================
//
// Graph mail subscriptions expire fast (max 4230 minutes ≈ 3 days), so a cron
// renews them well before the lease lapses. We stay a margin under the max.

export const GRAPH_SUBSCRIPTION_TTL_MS = 4000 * 60 * 1000;

/** Default resource: new mail landing in the Inbox. */
export const GRAPH_INBOX_RESOURCE = "/me/mailfolders('inbox')/messages";

export interface GraphSubscription {
  readonly id: string;
  readonly expirationDateTime: string;
}

/**
 * Create a change-notification subscription. NOTE: Graph validates
 * `notificationUrl` synchronously during this call by POSTing a
 * `validationToken` that our webhook must echo — so the webhook must be live
 * and publicly reachable before this succeeds.
 */
export const graphCreateSubscription = async (
  opts: GraphHttpCallOptions & {
    readonly notificationUrl: string;
    readonly clientState: string;
    readonly expirationDateTime: string;
    readonly resource?: string;
  },
): Promise<GraphSubscription> => {
  const raw = (await graphFetch({
    method: "POST",
    path: "/subscriptions",
    token: opts.token,
    body: {
      changeType: "created",
      notificationUrl: opts.notificationUrl,
      resource: opts.resource ?? GRAPH_INBOX_RESOURCE,
      expirationDateTime: opts.expirationDateTime,
      clientState: opts.clientState,
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as { id?: string; expirationDateTime?: string };
  return {
    id: raw.id ?? "",
    expirationDateTime: raw.expirationDateTime ?? opts.expirationDateTime,
  };
};

/** Extend an existing subscription's lease. */
export const graphRenewSubscription = async (
  opts: GraphHttpCallOptions & {
    readonly subscriptionId: string;
    readonly expirationDateTime: string;
  },
): Promise<GraphSubscription> => {
  const raw = (await graphFetch({
    method: "PATCH",
    path: `/subscriptions/${encodeURIComponent(opts.subscriptionId)}`,
    token: opts.token,
    body: { expirationDateTime: opts.expirationDateTime },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as { id?: string; expirationDateTime?: string };
  return {
    id: raw.id ?? opts.subscriptionId,
    expirationDateTime: raw.expirationDateTime ?? opts.expirationDateTime,
  };
};
