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

import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import type {
  ConversationMessage,
  ConversationThread,
  MessageParticipant,
} from "@support-agent/agent-core";
import { ThreadId as makeThreadId } from "@support-agent/agent-core";

// ============================================================
// Config + wire types
// ============================================================

export interface ImapSmtpConfig {
  readonly imapHost: string;
  readonly imapPort: number;
  readonly imapSecure: boolean;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly user: string;
  readonly password: string;
}

export interface RawImapMessage {
  readonly uid: number;
  /** RFC Message-ID, angle brackets stripped. */
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: ReadonlyArray<string>;
  readonly from: MessageParticipant;
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
  /** Send a message; returns the assigned Message-ID (brackets stripped). */
  readonly send: (input: ImapSendInput) => Promise<{ readonly messageId: string }>;
  /** Throws if IMAP or SMTP login fails — used by the connect endpoint. */
  readonly verify: () => Promise<void>;
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
    for (const p of [msg.from, ...msg.to]) {
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
  return {
    uid,
    messageId: stripBrackets(p.messageId ?? ""),
    inReplyTo: p.inReplyTo ? stripBrackets(p.inReplyTo) : null,
    references: normaliseReferences(p.references),
    from: firstAddress(p.from),
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

/**
 * Live `ImapSmtpOps` over a real server. Connects per operation (stateless) —
 * simpler and safe across many tenants at the cost of a connect handshake per
 * call. `fetchThread` searches INBOX (the customer's messages); our own sent
 * replies live in the Sent folder and are not included in v1.
 */
export const makeImapSmtpOps = (config: ImapSmtpConfig): ImapSmtpOps => {
  const newImap = () =>
    new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecure,
      auth: { user: config.user, pass: config.password },
      logger: false,
    });

  const newSmtp = () =>
    nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.user, pass: config.password },
    });

  const fetchThread = async (
    rootId: string,
  ): Promise<ReadonlyArray<RawImapMessage>> => {
    const client = newImap();
    await client.connect();
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
    const client = newImap();
    await client.connect();
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

  const send = async (
    input: ImapSendInput,
  ): Promise<{ messageId: string }> => {
    const transport = newSmtp();
    try {
      const info = await transport.sendMail({
        from: formatAddress(input.from),
        to: input.to.map(formatAddress),
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.references.length > 0
          ? { references: input.references.slice() }
          : {}),
      });
      return { messageId: stripBrackets(info.messageId ?? "") };
    } finally {
      transport.close();
    }
  };

  const verify = async (): Promise<void> => {
    const client = newImap();
    await client.connect();
    await client.logout();
    const transport = newSmtp();
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  };

  return { fetchThread, listSince, send, verify };
};
