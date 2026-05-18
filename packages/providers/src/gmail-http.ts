// ============================================================
// Gmail Admin HTTP — low-level wire format
// ============================================================
//
// Plain async functions over `fetch` (no Effect Tag — the Live
// ConversationService wraps these). The same helpers are imported by
// `apps/api`'s Gmail webhook handler so the parsing logic stays DRY.
//
// We deliberately avoid the `googleapis` npm package: it's enormous,
// pulls a Node-only auth library transitively, and we only use ~4 Gmail
// endpoints. Hand-rolled HTTP is cheaper and lets us unit-test against a
// mocked fetch with no globals.

import type {
  ConversationMessage,
  InboundMessage,
  MessageParticipant,
  ThreadId,
} from "@support-agent/agent-core";
import { ThreadId as makeThreadId } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export type GmailHttpFailure =
  | { readonly kind: "auth_failed"; readonly status: number }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "not_found"; readonly status: number }
  | { readonly kind: "network"; readonly status: number; readonly body: string };

export class GmailHttpError extends Error {
  readonly failure: GmailHttpFailure;
  constructor(failure: GmailHttpFailure, message: string) {
    super(message);
    this.failure = failure;
    this.name = "GmailHttpError";
  }
}

// ============================================================
// Internal fetch wrapper
// ============================================================

interface GmailFetchOptions {
  readonly method?: "GET" | "POST";
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
  readonly fetchImpl?: typeof fetch;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

const gmailFetch = async (opts: GmailFetchOptions): Promise<unknown> => {
  const f = opts.fetchImpl ?? fetch;
  const init: Parameters<typeof fetch>[1] = {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await f(`${GMAIL_BASE}${opts.path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new GmailHttpError(
        { kind: "auth_failed", status: res.status },
        `gmail ${opts.path}: ${res.status}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      throw new GmailHttpError(
        { kind: "rate_limited", retryAfterMs: retryAfter * 1000 },
        `gmail ${opts.path}: 429`,
      );
    }
    if (res.status === 404) {
      throw new GmailHttpError(
        { kind: "not_found", status: 404 },
        `gmail ${opts.path}: 404`,
      );
    }
    throw new GmailHttpError(
      { kind: "network", status: res.status, body: text },
      `gmail ${opts.path}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as unknown;
};

// ============================================================
// Wire types — only the bits we read
// ============================================================

interface RawHeader {
  readonly name: string;
  readonly value: string;
}

interface RawPart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: ReadonlyArray<RawHeader>;
  readonly body?: { readonly data?: string; readonly attachmentId?: string; readonly size?: number };
  readonly parts?: ReadonlyArray<RawPart>;
}

interface RawMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: ReadonlyArray<string>;
  readonly historyId?: string;
  readonly internalDate?: string;
  readonly payload?: RawPart;
}

interface RawThread {
  readonly id: string;
  readonly historyId?: string;
  readonly messages?: ReadonlyArray<RawMessage>;
}

interface RawHistoryEntry {
  readonly id: string;
  readonly messagesAdded?: ReadonlyArray<{ readonly message: { readonly id: string; readonly threadId: string; readonly labelIds?: ReadonlyArray<string> } }>;
}

interface RawHistoryList {
  readonly history?: ReadonlyArray<RawHistoryEntry>;
  readonly historyId?: string;
  readonly nextPageToken?: string;
}

interface RawSendResponse {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: ReadonlyArray<string>;
}

// ============================================================
// Header + body decoding
// ============================================================

const headerLookup = (headers: ReadonlyArray<RawHeader>, name: string): string | null => {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
};

const decodeBase64Url = (s: string): string =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const encodeBase64Url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const collectBodies = (
  part: RawPart,
  out: { text: string[]; html: string[] },
): void => {
  if (part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if ((part.mimeType ?? "").startsWith("text/html")) {
      out.html.push(decoded);
    } else {
      // Default to plain — Gmail uses `text/plain` and sometimes omits the
      // type for tiny payloads.
      out.text.push(decoded);
    }
  }
  if (part.parts) {
    for (const child of part.parts) collectBodies(child, out);
  }
};

// RFC 5322-ish address parsing: "Name <addr@host>" or just "addr@host" or
// comma-separated. We tolerate junk because customer mail is messy; bad
// entries get dropped silently.
const parseAddressList = (raw: string | null): ReadonlyArray<MessageParticipant> => {
  if (!raw) return [];
  const out: Array<MessageParticipant> = [];
  for (const piece of splitAddresses(raw)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const lt = trimmed.lastIndexOf("<");
    const gt = trimmed.lastIndexOf(">");
    if (lt !== -1 && gt > lt) {
      const email = trimmed.slice(lt + 1, gt).trim();
      const name = trimmed.slice(0, lt).trim().replace(/^"|"$/g, "").trim();
      if (email) out.push({ name: name || null, email });
    } else if (trimmed.includes("@")) {
      out.push({ name: null, email: trimmed });
    }
  }
  return out;
};

// Comma-split that respects quoted display names.
const splitAddresses = (raw: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  let buf = "";
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
};

const firstAddress = (raw: string | null): MessageParticipant | null => {
  const list = parseAddressList(raw);
  return list[0] ?? null;
};

// ============================================================
// Normalisers
// ============================================================

const normaliseMessage = (m: RawMessage, threadId: ThreadId): ConversationMessage => {
  const headers = m.payload?.headers ?? [];
  const bodies = { text: [] as Array<string>, html: [] as Array<string> };
  if (m.payload) collectBodies(m.payload, bodies);

  const labels = m.labelIds ?? [];
  const direction: "inbound" | "outbound" = labels.includes("SENT")
    ? "outbound"
    : "inbound";

  const from = firstAddress(headerLookup(headers, "From")) ?? {
    name: null,
    email: "",
  };
  const to = parseAddressList(headerLookup(headers, "To"));
  const subject = headerLookup(headers, "Subject");
  const sentAt = m.internalDate
    ? new Date(Number(m.internalDate))
    : new Date();

  return {
    id: m.id,
    threadId,
    direction,
    from,
    to,
    subject: subject ?? null,
    bodyText: bodies.text.join("\n").trim(),
    bodyHtml: bodies.html.length > 0 ? bodies.html.join("\n") : null,
    sentAt,
    attachments: [], // TODO: surface attachment metadata when a tool needs it
  };
};

export interface NormalisedThread {
  readonly id: ThreadId;
  readonly historyId: string | null;
  readonly subject: string;
  readonly participants: ReadonlyArray<MessageParticipant>;
  readonly messages: ReadonlyArray<ConversationMessage>;
}

const normaliseThread = (raw: RawThread): NormalisedThread => {
  const threadId = makeThreadId(raw.id);
  const messages = (raw.messages ?? []).map((m) => normaliseMessage(m, threadId));
  const subject =
    messages[0]?.subject ?? "(no subject)";
  // Distinct addresses across the thread, in first-seen order.
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
  return {
    id: threadId,
    historyId: raw.historyId ?? null,
    subject,
    participants,
    messages,
  };
};

// ============================================================
// Public helpers
// ============================================================

export interface GmailHttpCallOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export const gmailGetThread = async (
  opts: GmailHttpCallOptions & { readonly threadId: string },
): Promise<NormalisedThread> => {
  const raw = (await gmailFetch({
    path: `/users/me/threads/${encodeURIComponent(opts.threadId)}?format=full`,
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawThread;
  return normaliseThread(raw);
};

export const gmailGetMessage = async (
  opts: GmailHttpCallOptions & { readonly messageId: string },
): Promise<ConversationMessage & { readonly threadId: ThreadId; readonly labelIds: ReadonlyArray<string> }> => {
  const raw = (await gmailFetch({
    path: `/users/me/messages/${encodeURIComponent(opts.messageId)}?format=full`,
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawMessage;
  const threadId = makeThreadId(raw.threadId);
  const msg = normaliseMessage(raw, threadId);
  return { ...msg, threadId, labelIds: raw.labelIds ?? [] };
};

// ============================================================
// Reseed primitives — used when history.list returns 404 (cursor
// older than Gmail's ~7-day history retention).
// ============================================================

interface RawProfile {
  readonly emailAddress?: string;
  readonly historyId?: string;
}

/**
 * Fetch the mailbox's current `historyId`. The webhook reseed path uses
 * this as the "advance-to" cursor after a reseed completes.
 */
export const gmailGetProfile = async (
  opts: GmailHttpCallOptions,
): Promise<{ readonly emailAddress: string; readonly historyId: string }> => {
  const raw = (await gmailFetch({
    path: "/users/me/profile",
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawProfile;
  if (!raw.emailAddress || !raw.historyId) {
    throw new GmailHttpError(
      { kind: "network", status: 200, body: JSON.stringify(raw) },
      "gmail profile missing emailAddress/historyId",
    );
  }
  return { emailAddress: raw.emailAddress, historyId: raw.historyId };
};

interface RawMessageList {
  readonly messages?: ReadonlyArray<{
    readonly id: string;
    readonly threadId: string;
  }>;
  readonly nextPageToken?: string;
}

/**
 * List message ids matching a Gmail search query. Used by the webhook
 * reseed path with `q=in:inbox newer_than:7d` to recover after a stale
 * `historyId` 404. Caps at the first page (Gmail returns ≤100 ids per
 * page by default; we ask for 50 to keep per-tick work bounded).
 */
export const gmailListInboxMessageIds = async (
  opts: GmailHttpCallOptions & {
    readonly query: string;
    readonly maxResults?: number;
  },
): Promise<ReadonlyArray<string>> => {
  const params = new URLSearchParams({
    q: opts.query,
    maxResults: String(opts.maxResults ?? 50),
  });
  const raw = (await gmailFetch({
    path: `/users/me/messages?${params.toString()}`,
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawMessageList;
  return (raw.messages ?? []).map((m) => m.id);
};

export const gmailListHistory = async (
  opts: GmailHttpCallOptions & {
    readonly startHistoryId: string;
    readonly labelId?: string;
  },
): Promise<{
  readonly newMessageIds: ReadonlyArray<string>;
  readonly latestHistoryId: string | null;
}> => {
  const params = new URLSearchParams({
    startHistoryId: opts.startHistoryId,
    historyTypes: "messageAdded",
  });
  if (opts.labelId) params.set("labelId", opts.labelId);
  const raw = (await gmailFetch({
    path: `/users/me/history?${params.toString()}`,
    token: opts.token,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawHistoryList;
  const ids: Array<string> = [];
  const seen = new Set<string>();
  for (const entry of raw.history ?? []) {
    for (const ma of entry.messagesAdded ?? []) {
      const labels = ma.message.labelIds ?? [];
      // Limit to INBOX so SENT echoes and trash drafts don't trigger us.
      if (!labels.includes("INBOX")) continue;
      if (seen.has(ma.message.id)) continue;
      seen.add(ma.message.id);
      ids.push(ma.message.id);
    }
  }
  return { newMessageIds: ids, latestHistoryId: raw.historyId ?? null };
};

// ============================================================
// Outbound MIME
// ============================================================

export interface OutboundMimeOptions {
  readonly from: MessageParticipant;
  readonly to: ReadonlyArray<MessageParticipant>;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml?: string | null;
  /** Used for proper threading: `In-Reply-To` + `References`. */
  readonly inReplyToMessageId?: string | null;
  readonly references?: ReadonlyArray<string>;
}

const encodeHeaderAddress = (p: MessageParticipant): string =>
  p.name ? `"${p.name.replace(/"/g, "")}" <${p.email}>` : p.email;

/**
 * Build an RFC 5322-shaped message and base64url-encode it for the Gmail
 * `users.messages.send` body. We only emit text/plain bodies for now;
 * `bodyHtml`, if present, switches to a `multipart/alternative` envelope.
 */
export const buildGmailMime = (opts: OutboundMimeOptions): string => {
  const lines: Array<string> = [];
  lines.push(`From: ${encodeHeaderAddress(opts.from)}`);
  lines.push(`To: ${opts.to.map(encodeHeaderAddress).join(", ")}`);
  // RFC 2047 isn't worth pulling in a library for; ASCII-only subject keeps
  // things sane until a tenant complains. Strip control chars defensively.
  lines.push(`Subject: ${opts.subject.replace(/[\r\n]+/g, " ")}`);
  if (opts.inReplyToMessageId) {
    lines.push(`In-Reply-To: <${opts.inReplyToMessageId}>`);
  }
  if (opts.references && opts.references.length > 0) {
    lines.push(`References: ${opts.references.map((r) => `<${r}>`).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0");

  if (opts.bodyHtml) {
    const boundary = `=_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("");
    lines.push(opts.bodyText);
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push("");
    lines.push(opts.bodyHtml);
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("");
    lines.push(opts.bodyText);
  }
  return encodeBase64Url(lines.join("\r\n"));
};

export interface GmailSendOptions extends GmailHttpCallOptions {
  /** base64url-encoded RFC 5322 message (use `buildGmailMime`). */
  readonly raw: string;
  /** Required for replies — threads on the existing conversation. */
  readonly threadId?: string;
}

export interface GmailSendResult {
  readonly messageId: string;
  readonly threadId: string;
}

export const gmailSendMessage = async (
  opts: GmailSendOptions,
): Promise<GmailSendResult> => {
  const body: Record<string, unknown> = { raw: opts.raw };
  if (opts.threadId) body["threadId"] = opts.threadId;
  const raw = (await gmailFetch({
    method: "POST",
    path: "/users/me/messages/send",
    token: opts.token,
    body,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })) as RawSendResponse;
  return { messageId: raw.id, threadId: raw.threadId };
};

// ============================================================
// ConversationMessage → InboundMessage (event boundary)
// ============================================================

export const toInboundMessage = (
  msg: ConversationMessage,
): InboundMessage => ({
  threadId: msg.threadId,
  messageId: msg.id,
  from: msg.from,
  to: msg.to,
  subject: msg.subject ?? "(no subject)",
  bodyText: msg.bodyText,
  bodyHtml: msg.bodyHtml,
  receivedAt: msg.sentAt,
  attachments: msg.attachments,
});
