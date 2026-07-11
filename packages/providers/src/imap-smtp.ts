// ============================================================
// Generic IMAP/SMTP transport — the universal mailbox connector
// ============================================================
//
// Covers every provider that isn't Gmail or Microsoft (PrivateEmail, Zoho,
// Fastmail, cPanel hosting, any custom domain). Unlike Gmail/Graph these are
// stateful TCP protocols, not REST, so we lean on `imapflow` (read),
// `nodemailer` (send), and `mailparser` (MIME → text/html).
//
// The pure helpers below (threadRootId / normalisation) are unit-tested; the
// `makeImapSmtpOps` glue talks to a live server and is verified with real
// credentials, the same way the Gmail/Graph HTTP layers are.

import { createHash, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import type {
  ConversationMessage,
  ConversationThread,
  MessageParticipant,
} from "@support-agent/agent-core";
import { ThreadId as makeThreadId } from "@support-agent/agent-core";
import type { ConnectorConnection } from "@support-agent/services";
import {
  encodeBase64Lines,
  sanitizeMimeFilename,
  type OutboundAttachment,
} from "./outbound-attachments.js";

// ============================================================
// Config + wire types
// ============================================================

export type SentSaveMode = "auto" | "smtp_provider" | "imap_append" | "none";

export interface ImapSmtpConfig {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly user: string;
  readonly password: string;
  /**
   * How outbound SMTP sends should appear in the mailbox's Sent folder.
   *
   * - auto: wait briefly, search Sent for the SMTP Message-ID, append only if
   *   the provider did not save it.
   * - smtp_provider: trust the provider to save submitted SMTP mail.
   * - imap_append: always manage the Sent copy from this app, still searching
   *   first to avoid duplicates if provider behavior changes.
   * - none: do not attempt to save a Sent copy.
   */
  readonly sentSaveMode?: SentSaveMode;
  /** Sent mailbox path. Defaults to the folder with \Sent special-use, then "Sent". */
  readonly sentMailbox?: string;
  /** Test/operator override for auto-save propagation wait. Defaults to 1500ms. */
  readonly sentCheckDelayMs?: number;
}

export interface RawImapMessage {
  readonly uid: number;
  /** RFC Message-ID, angle brackets stripped. */
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
  readonly from: MessageParticipant;
  /** `Reply-To` address when the message carried one; null otherwise. */
  readonly replyTo: MessageParticipant | null;
  readonly to: ReadonlyArray<MessageParticipant>;
  readonly subject: string | null;
  readonly date: Date;
  readonly text: string;
  readonly html: string | null;
}

export interface ImapSendInput {
  readonly from: MessageParticipant;
  readonly to: ReadonlyArray<MessageParticipant>;
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
  /** Resolved attachment bytes; encoded by SMTP send + the Sent-folder copy. */
  readonly attachments?: ReadonlyArray<OutboundAttachment>;
  /** Stable key for retrying the same logical outbound draft. */
  readonly idempotencyKey?: string;
}

/**
 * Minimal surface the conversation connector needs. The Live impl
 * ({@link makeImapSmtpOps}) talks to a real server; tests inject a fake.
 */
export interface ImapSmtpOps {
  /** Every message in a thread (matched by root Message-ID), in arrival order. */
  readonly fetchThread: (
    threadRootId: string,
  ) => Promise<ReadonlyArray<RawImapMessage>>;
  /** New INBOX messages with UID greater than `sinceUid`. */
  readonly listSince: (
    sinceUid: number,
  ) => Promise<{ readonly messages: ReadonlyArray<RawImapMessage>; readonly latestUid: number }>;
  /** Highest INBOX UID, without fetching bodies — used to seed the poll cursor. */
  readonly latestUid: () => Promise<number>;
  /** Mark INBOX messages as read after the workflow has accepted them. */
  readonly markRead: (uids: ReadonlyArray<number>) => Promise<void>;
  /** Send a message; returns the assigned Message-ID (brackets stripped). */
  readonly send: (input: ImapSendInput) => Promise<{ readonly messageId: string }>;
  /** Throws if IMAP or SMTP login fails — used by the connect endpoint. */
  readonly verify: () => Promise<void>;
}

interface ImapMailboxLock {
  readonly release: () => void;
}

interface ImapFetchMessage {
  readonly uid: number;
  readonly source?: Buffer;
}

interface ImapMailboxInfo {
  readonly uidNext?: number | string;
}

interface ImapMailboxListEntry {
  readonly path?: string;
  readonly name?: string;
  readonly specialUse?: string;
  readonly flags?: ReadonlyArray<string>;
}

interface ImapClientLike {
  readonly secureConnection: boolean;
  readonly connect: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly getMailboxLock: (path: string) => Promise<ImapMailboxLock>;
  readonly search: (
    query: Record<string, unknown>,
    options: { readonly uid: true },
  ) => Promise<ReadonlyArray<number>>;
  readonly fetch: (
    range: unknown,
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => AsyncIterable<ImapFetchMessage>;
  readonly mailboxOpen: (path: string) => Promise<ImapMailboxInfo>;
  readonly messageFlagsAdd?: (
    range: unknown,
    flags: ReadonlyArray<string>,
    options?: Record<string, unknown>,
  ) => Promise<boolean>;
  readonly append?: (
    path: string,
    content: Buffer,
    flags?: ReadonlyArray<string>,
    idate?: Date,
  ) => Promise<unknown>;
  readonly list?: () => Promise<ReadonlyArray<ImapMailboxListEntry>>;
}

interface SmtpTransportLike {
  readonly sendMail: (
    message: Record<string, unknown>,
  ) => Promise<{ readonly messageId?: string | null }>;
  readonly verify: () => Promise<void>;
  readonly close?: () => void;
}

export interface ImapSmtpOpsDeps {
  readonly imapFactory?: () => ImapClientLike;
  readonly smtpFactory?: () => SmtpTransportLike;
  readonly delay?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly mintMessageId?: () => string;
}

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

export const stripBrackets = (s: string): string =>
  s.replace(/^<+/, "").replace(/>+$/, "").trim();

/**
 * The thread's stable id: the first entry in `References` (the conversation
 * root) if present, else the message's own id (it IS the root). Every reply
 * carries the root in References, so all messages in a thread map to the
 * same id.
 */
export const threadRootId = (msg: {
  readonly messageId: string;
  readonly references: ReadonlyArray<string>;
}): string => msg.references[0] ?? msg.messageId;

export const toConversationMessage = (
  raw: RawImapMessage,
  mailbox: string,
): ConversationMessage => ({
  id: raw.messageId,
  threadId: makeThreadId(threadRootId(raw)),
  direction:
    raw.from.email.toLowerCase() === mailbox.toLowerCase()
      ? "outbound"
      : "inbound",
  from: raw.from,
  replyTo: raw.replyTo,
  to: raw.to,
  subject: raw.subject,
  bodyText: raw.text,
  bodyHtml: raw.html,
  sentAt: raw.date,
  attachments: [],
});

export const buildThread = (
  raws: ReadonlyArray<RawImapMessage>,
  threadId: string,
  mailbox: string,
): ConversationThread => {
  const messages = raws
    .map((r) => toConversationMessage(r, mailbox))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const subject = messages[0]?.subject ?? "(no subject)";
  const seen = new Set<string>();
  const participants: Array<MessageParticipant> = [];
  for (const msg of messages) {
    for (const p of [
      msg.from,
      ...(msg.replyTo ? [msg.replyTo] : []),
      ...msg.to,
    ]) {
      if (!p.email) continue;
      const key = p.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push(p);
    }
  }
  return { id: makeThreadId(threadId), subject, participants, messages };
};

// ============================================================
// Config from a stored connection
// ============================================================

const numFromMeta = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const boolFromMeta = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

const sentSaveModeFromMeta = (v: unknown): SentSaveMode =>
  v === "smtp_provider" || v === "imap_append" || v === "none" ? v : "auto";

/**
 * Build transport config from a stored `imap` connection: app-password in
 * `accessToken`, host/port/security in `metadata`, mailbox in `shopDomain`
 * (also the default login user). Returns `null` when host metadata is missing.
 */
export const imapConfigFromConnection = (
  conn: ConnectorConnection,
): ImapSmtpConfig | null => {
  const m = conn.metadata;
  const imapHost = m["imapHost"];
  const smtpHost = m["smtpHost"];
  if (typeof imapHost !== "string" || !imapHost) return null;
  if (typeof smtpHost !== "string" || !smtpHost) return null;
  const user =
    typeof m["user"] === "string" && m["user"] ? (m["user"] as string) : conn.shopDomain;
  const smtpPort = numFromMeta(m["smtpPort"], 465);
  const sentMailbox =
    typeof m["sentMailbox"] === "string" && m["sentMailbox"]
      ? (m["sentMailbox"] as string)
      : null;
  return {
    imapHost,
    imapPort: numFromMeta(m["imapPort"], 993),
    imapSecure: boolFromMeta(m["imapSecure"], true),
    smtpHost,
    smtpPort,
    smtpSecure: boolFromMeta(m["smtpSecure"], smtpPort === 465),
    user,
    password: conn.accessToken,
    sentSaveMode: sentSaveModeFromMeta(m["sentSaveMode"]),
    ...(sentMailbox ? { sentMailbox } : {}),
    sentCheckDelayMs: numFromMeta(m["sentCheckDelayMs"], 1500),
  };
};

// ============================================================
// TLS policy (S7) — never authenticate over cleartext
// ============================================================
//
// `secure: true` is implicit TLS. `secure: false` is MANDATORY STARTTLS: the
// connection aborts before any credentials are sent when the server (or a
// MITM stripping the capability) can't upgrade. Both transports are floored
// at TLS 1.2 with certificate verification on.

const TLS_FLOOR = { minVersion: "TLSv1.2", rejectUnauthorized: true } as const;

// ============================================================
// Connection timeouts — never let a stuck socket hang a tick
// ============================================================
//
// We connect per operation against tenant-owned mailboxes we don't control.
// Without explicit timeouts a hung TCP/TLS handshake falls back to the
// libraries' defaults (nodemailer's socketTimeout is 10 minutes), so a single
// unreachable server would block the whole runtime tick — the reply looks like
// it "never sends". These bounded values surface the failure in seconds so the
// reply-delivery retry can take over instead.
const TIMEOUTS = {
  /** Max time to establish the TCP/TLS connection. */
  connectionTimeout: 15_000,
  /** Max wait for the server's protocol greeting after connect. */
  greetingTimeout: 10_000,
  /** Max socket inactivity once connected (covers slow AUTH / fetch). */
  socketTimeout: 30_000,
} as const;

/** imapflow options for a stored config. Exported for unit tests. */
export const imapClientOptions = (config: ImapSmtpConfig) => ({
  host: config.imapHost,
  port: config.imapPort,
  secure: config.imapSecure,
  // doSTARTTLS=true makes the upgrade a requirement — imapflow fails the
  // connect (pre-auth) when the server lacks STARTTLS. It is invalid
  // combined with secure=true, hence the conditional spread.
  ...(config.imapSecure ? {} : { doSTARTTLS: true }),
  auth: { user: config.user, pass: config.password },
  logger: false as const,
  tls: TLS_FLOOR,
  ...TIMEOUTS,
});

/** nodemailer transport options for a stored config. Exported for unit tests. */
export const smtpTransportOptions = (config: ImapSmtpConfig) => ({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  // requireTLS makes STARTTLS mandatory on a non-implicit-TLS connection —
  // verify/send fail instead of continuing in cleartext.
  ...(config.smtpSecure ? {} : { requireTLS: true }),
  auth: { user: config.user, pass: config.password },
  tls: TLS_FLOOR,
  ...TIMEOUTS,
});

// ============================================================
// MIME parsing (mailparser)
// ============================================================

const addressToParticipant = (a?: {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
}): MessageParticipant => ({
  name: a?.name && a.name.length > 0 ? a.name : null,
  email: a?.address ?? "",
});

const firstAddress = (obj: AddressObject | AddressObject[] | undefined): MessageParticipant => {
  const one = Array.isArray(obj) ? obj[0] : obj;
  return addressToParticipant(one?.value?.[0]);
};

const allAddresses = (
  obj: AddressObject | AddressObject[] | undefined,
): ReadonlyArray<MessageParticipant> => {
  const objs = Array.isArray(obj) ? obj : obj ? [obj] : [];
  return objs.flatMap((o) => (o.value ?? []).map(addressToParticipant));
};

const normaliseReferences = (
  refs: string | string[] | undefined,
): ReadonlyArray<string> => {
  if (!refs) return [];
  const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
  return arr.map(stripBrackets).filter((r) => r.length > 0);
};

/** Parse a raw RFC822 message into our wire shape. Exported for the glue + tests. */
export const parseRawImapMessage = async (
  uid: number,
  source: Buffer,
): Promise<RawImapMessage> => {
  const p = await simpleParser(source);
  const replyTo = firstAddress(p.replyTo);
  return {
    uid,
    messageId: stripBrackets(p.messageId ?? ""),
    inReplyTo: p.inReplyTo ? stripBrackets(p.inReplyTo) : null,
    references: normaliseReferences(p.references),
    from: firstAddress(p.from),
    replyTo: replyTo.email ? replyTo : null,
    to: allAddresses(p.to),
    subject: p.subject ?? null,
    date: p.date ?? new Date(0),
    text: p.text ?? "",
    html: typeof p.html === "string" ? p.html : null,
  };
};

// ============================================================
// Live ops (imapflow + nodemailer)
// ============================================================

const formatAddress = (p: MessageParticipant): string =>
  p.name ? `${p.name} <${p.email}>` : p.email;

const DEFAULT_SENT_MAILBOX = "Sent";
const DEFAULT_SENT_CHECK_DELAY_MS = 1500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const normaliseMessageId = (s: string): string =>
  stripBrackets(s).replace(/[<>\r\n]/g, "").trim();

const headerValue = (s: string): string =>
  s.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();

const mimeAddress = (p: MessageParticipant): string => {
  const email = headerValue(p.email);
  if (!p.name) return email;
  const name = headerValue(p.name).replace(/"/g, "");
  return name ? `"${name}" <${email}>` : email;
};

const messageIdDomain = (fromEmail: string): string => {
  const domain = fromEmail.split("@").at(-1)?.toLowerCase() ?? "";
  const clean = domain.replace(/[^a-z0-9.-]/g, "");
  return clean.length > 0 ? clean : "support-agent.local";
};

const makeMessageId = (
  fromEmail: string,
  seed: string | null,
  mint: () => string = randomUUID,
): string => {
  const token = seed
    ? createHash("sha256").update(seed).digest("hex").slice(0, 32)
    : mint().replace(/[^a-zA-Z0-9]/g, "");
  return `sa-${token}@${messageIdDomain(fromEmail)}`;
};

const messageIdSeed = (input: ImapSendInput): string | null =>
  input.idempotencyKey
    ? [
        input.idempotencyKey,
        input.from.email,
        input.to.map((p) => p.email.toLowerCase()).join(","),
        input.subject,
        input.text,
        input.html ?? "",
        input.inReplyTo ?? "",
        input.references.join(" "),
      ].join("\0")
    : null;

const buildSentMime = (
  input: ImapSendInput,
  messageId: string,
  date: Date,
): Buffer => {
  const lines: Array<string> = [];
  lines.push(`Message-ID: <${normaliseMessageId(messageId)}>`);
  lines.push(`Date: ${date.toUTCString()}`);
  lines.push(`From: ${mimeAddress(input.from)}`);
  lines.push(`To: ${input.to.map(mimeAddress).join(", ")}`);
  lines.push(`Subject: ${headerValue(input.subject)}`);
  const inReplyTo = input.inReplyTo ? normaliseMessageId(input.inReplyTo) : null;
  if (inReplyTo) lines.push(`In-Reply-To: <${inReplyTo}>`);
  const references = input.references
    .map(normaliseMessageId)
    .filter((r) => r.length > 0);
  if (references.length > 0) {
    lines.push(`References: ${references.map((r) => `<${r}>`).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0");

  const idSlug = normaliseMessageId(messageId).replace(/[^a-zA-Z0-9]/g, "");
  const pushBody = (out: Array<string>): void => {
    if (input.html) {
      const boundary = `=_support_agent_${idSlug}`;
      out.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      out.push("");
      out.push(`--${boundary}`);
      out.push('Content-Type: text/plain; charset="UTF-8"');
      out.push("");
      out.push(input.text);
      out.push(`--${boundary}`);
      out.push('Content-Type: text/html; charset="UTF-8"');
      out.push("");
      out.push(input.html);
      out.push(`--${boundary}--`);
    } else {
      out.push('Content-Type: text/plain; charset="UTF-8"');
      out.push("");
      out.push(input.text);
    }
  };

  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    pushBody(lines);
    return Buffer.from(lines.join("\r\n"), "utf8");
  }

  // Sent copy must mirror what SMTP delivered: multipart/mixed with the
  // body first, then each attachment base64-encoded.
  const mixedBoundary = `=_support_agent_mixed_${idSlug}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  lines.push("");
  lines.push(`--${mixedBoundary}`);
  pushBody(lines);
  for (const attachment of attachments) {
    const filename = sanitizeMimeFilename(attachment.filename);
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: ${attachment.contentType}; name="${filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push("");
    lines.push(encodeBase64Lines(attachment.bytes));
  }
  lines.push(`--${mixedBoundary}--`);
  return Buffer.from(lines.join("\r\n"), "utf8");
};

const resolveSentMailbox = async (
  client: ImapClientLike,
  configured: string | undefined,
): Promise<string> => {
  if (configured && configured.length > 0) return configured;
  const boxes = client.list ? await client.list() : [];
  const sent =
    boxes.find((b) => b.specialUse === "\\Sent" || b.flags?.includes("\\Sent")) ??
    boxes.find((b) => {
      const name = (b.path ?? b.name ?? "").toLowerCase();
      return name === "sent" || name.endsWith("/sent") || name.endsWith(".sent");
    });
  return sent?.path ?? sent?.name ?? DEFAULT_SENT_MAILBOX;
};

const sentContainsMessage = async (
  client: ImapClientLike,
  mailbox: string,
  messageId: string,
): Promise<boolean> => {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uids =
      (await client.search(
        { header: { "message-id": normaliseMessageId(messageId) } },
        { uid: true },
      )) || [];
    return uids.length > 0;
  } finally {
    lock.release();
  }
};

/**
 * Live `ImapSmtpOps` over a real server. Connects per operation (stateless) —
 * simpler and safe across many tenants at the cost of a connect handshake per
 * call. `fetchThread` searches INBOX (the customer's messages); our own sent
 * replies live in the Sent folder and are not included in v1.
 */
export const makeImapSmtpOps = (
  config: ImapSmtpConfig,
  deps: ImapSmtpOpsDeps = {},
): ImapSmtpOps => {
  const sleep = deps.delay ?? delay;
  const now = deps.now ?? (() => new Date());
  const connectImap = async (): Promise<ImapClientLike> => {
    const client = deps.imapFactory
      ? deps.imapFactory()
      : (new ImapFlow(imapClientOptions(config)) as unknown as ImapClientLike);
    await client.connect();
    // Belt-and-braces alongside doSTARTTLS: never operate on a session that
    // somehow ended up cleartext, even if the strict option regresses.
    if (!client.secureConnection) {
      await client.logout().catch(() => undefined);
      throw new Error("imap connection is not secure (TLS required)");
    }
    return client;
  };

  const newSmtp = (): SmtpTransportLike =>
    deps.smtpFactory
      ? deps.smtpFactory()
      : (nodemailer.createTransport(
          smtpTransportOptions(config),
        ) as unknown as SmtpTransportLike);

  const maybeSaveSentCopy = async (
    input: ImapSendInput,
    messageId: string,
    sentDate: Date,
  ): Promise<void> => {
    const mode = config.sentSaveMode ?? "auto";
    if (mode === "smtp_provider" || mode === "none") return;

    try {
      if (mode === "auto") {
        await sleep(config.sentCheckDelayMs ?? DEFAULT_SENT_CHECK_DELAY_MS);
      }
      const client = await connectImap();
      try {
        const mailbox = await resolveSentMailbox(client, config.sentMailbox);
        if (await sentContainsMessage(client, mailbox, messageId)) return;
        if (!client.append) return;
        await client.append(
          mailbox,
          buildSentMime(input, messageId, sentDate),
          ["\\Seen"],
          sentDate,
        );
      } finally {
        await client.logout();
      }
    } catch {
      // SMTP already accepted the customer-facing message. Do not surface a
      // Sent-folder bookkeeping failure as a send failure, because a runtime
      // retry could send the customer a duplicate email.
    }
  };

  const fetchThread = async (
    rootId: string,
  ): Promise<ReadonlyArray<RawImapMessage>> => {
    const client = await connectImap();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search(
          {
            or: [
              { header: { "message-id": rootId } },
              { header: { references: rootId } },
              { header: { "in-reply-to": rootId } },
            ],
          },
          { uid: true },
        )) || [];
        if (uids.length === 0) return [];
        const out: Array<RawImapMessage> = [];
        for await (const msg of client.fetch(
          uids,
          { uid: true, source: true },
          { uid: true },
        )) {
          if (msg.source) out.push(await parseRawImapMessage(msg.uid, msg.source));
        }
        return out;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  };

  const listSince = async (
    sinceUid: number,
  ): Promise<{ messages: ReadonlyArray<RawImapMessage>; latestUid: number }> => {
    const client = await connectImap();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const out: Array<RawImapMessage> = [];
        let latest = sinceUid;
        // `n:*` always yields the highest message even if none are newer, so
        // we filter on uid > sinceUid below.
        for await (const msg of client.fetch(
          { uid: `${sinceUid + 1}:*` },
          { uid: true, source: true },
          { uid: true },
        )) {
          if (msg.uid <= sinceUid) continue;
          if (msg.source) out.push(await parseRawImapMessage(msg.uid, msg.source));
          if (msg.uid > latest) latest = msg.uid;
        }
        return { messages: out, latestUid: latest };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  };

  const latestUid = async (): Promise<number> => {
    const client = await connectImap();
    try {
      const mb = await client.mailboxOpen("INBOX");
      // `uidNext` is the UID the next message will get, so the highest current
      // UID is one less (0 when the mailbox is empty / uidNext is 1).
      return Math.max(0, Number(mb.uidNext) - 1);
    } finally {
      await client.logout();
    }
  };

  const markRead = async (uids: ReadonlyArray<number>): Promise<void> => {
    const unique = [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0);
    if (unique.length === 0) return;
    const client = await connectImap();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd?.(unique, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  };

  const send = async (
    input: ImapSendInput,
  ): Promise<{ messageId: string }> => {
    const transport = newSmtp();
    const messageId = makeMessageId(
      input.from.email,
      messageIdSeed(input),
      deps.mintMessageId,
    );
    const sentDate = now();
    try {
      const info = await transport.sendMail({
        messageId: `<${messageId}>`,
        from: formatAddress(input.from),
        to: input.to.map(formatAddress),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.references.length > 0
          ? { references: input.references.slice() }
          : {}),
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                content: Buffer.from(a.bytes),
              })),
            }
          : {}),
      });
      const acceptedId = normaliseMessageId(info.messageId ?? messageId) || messageId;
      await maybeSaveSentCopy(input, acceptedId, sentDate);
      return { messageId: acceptedId };
    } finally {
      transport.close?.();
    }
  };

  const verify = async (): Promise<void> => {
    const client = await connectImap();
    await client.logout();
    const transport = newSmtp();
    try {
      await transport.verify();
    } finally {
      transport.close?.();
    }
  };

  return { fetchThread, listSince, latestUid, markRead, send, verify };
};
