import { Data } from "effect";
import type { TenantId, ThreadId } from "./ids.js";
import type { MessageAttachment } from "./payloads.js";

/**
 * Provider-neutral domain types for customer conversations. Every connector
 * (Gmail, Outlook, IMAP/SMTP, helpdesk products, marketing-message
 * providers) normalises into these shapes — the agent runtime and tools
 * NEVER reference provider-specific names, headers, or APIs.
 *
 * Master-plan §6 (ConversationService Tag) and §20 ("never moves earlier")
 * make this an invariant: a connector is something the platform talks to,
 * not something the platform is built around.
 *
 * Note: `MessageAttachment` and `InboundMessage` live in `payloads.ts`
 * (single source of truth at the event boundary). This file adds the
 * thread-history + outbound shapes used by `ConversationService`.
 */

// ============================================================
// Participants
// ============================================================

export interface MessageParticipant {
  readonly name: string | null;
  readonly email: string;
}

// ============================================================
// Messages + threads
// ============================================================

/**
 * One message in a conversation thread. Direction discriminates inbound
 * (customer → us) from outbound (us → customer). Provider id is opaque to
 * the runtime — connectors map their internal id (Gmail messageId, Outlook
 * itemId, helpdesk message uuid) into this string at the boundary.
 */
export interface ConversationMessage {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly direction: "inbound" | "outbound";
  readonly from: MessageParticipant;
  /**
   * `Reply-To` address, when the inbound message carried one. Mail that
   * arrives via a relay puts the real customer here, not in `from` — e.g. a
   * Shopify storefront contact form is sent `From: mailer@shopify.com` with
   * `Reply-To:` set to the shopper. Treat `replyTo ?? from` as "the
   * customer" for recipient, identity, and participant purposes. Absent for
   * outbound messages and ordinary mail with no Reply-To header.
   */
  readonly replyTo?: MessageParticipant | null;
  readonly to: ReadonlyArray<MessageParticipant>;
  /** `null` for non-first messages that inherit the thread subject. */
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly sentAt: Date;
  readonly attachments: ReadonlyArray<MessageAttachment>;
}

/**
 * A conversation thread with its full message history. Used by the
 * runtime to resume a paused ticket and by the `conversation.fetch_thread`
 * tool to give an agent the surrounding context before drafting a reply.
 */
export interface ConversationThread {
  readonly id: ThreadId;
  readonly subject: string;
  readonly participants: ReadonlyArray<MessageParticipant>;
  readonly messages: ReadonlyArray<ConversationMessage>;
}

// ============================================================
// Outbound drafts + send confirmation
// ============================================================

/**
 * What the runtime hands to a connector when sending a reply. Always
 * threaded — `threadId` carries the conversation continuity that
 * providers use for their native UI (Gmail thread, Outlook conversation,
 * helpdesk ticket).
 *
 * `draftId` is the idempotency key (master-plan §9): re-running a workflow
 * tick MUST NOT cause a duplicate send. Connectors track `(ticketId,
 * draftId)` and return the prior `SentMessage` on a re-attempt.
 */
export interface ConversationReply {
  readonly threadId: ThreadId;
  /** Exact connected mailbox that owns the thread. */
  readonly mailbox?: string;
  readonly to: ReadonlyArray<MessageParticipant>;
  /** `null` means inherit the thread's subject (`Re: <subject>`). */
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly attachments: ReadonlyArray<MessageAttachment>;
  readonly inReplyToMessageId: string | null;
  readonly draftId: string;
}

/**
 * Confirmation that a reply was accepted by the connector. The `id` is
 * the provider-assigned message id; we persist it so the next inbound
 * `customer.replied` (which references our message id as
 * `inReplyToMessageId`) threads back to the right ticket.
 */
export interface SentMessage {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly sentAt: Date;
}

// FNV-1a (32-bit) — a tiny, dependency-free deterministic hash. Only used to
// keep the Message-ID below collision-free after sanitisation; not security
// sensitive.
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * Deterministic RFC-5322 Message-ID for an outbound reply, derived purely from
 * the connector mailbox and the reply's `draftId`.
 *
 * H8 (retry-safe send): the send happens BEFORE the runtime commits its "sent"
 * marker, so a crash in that window redelivers the job and — with no marker —
 * the connector would re-send. Because `(mailbox, draftId)` always maps to the
 * SAME id, a connector stamps it on the outbound message and, before sending,
 * scans the thread for it: finding our own prior send means "already delivered,
 * return it" instead of double-sending. Crucially this can only ever SUPPRESS a
 * send that genuinely already landed (its id is in the thread) — a scan that
 * finds nothing simply sends, so a legitimate retry is never lost.
 *
 * Returned WITHOUT angle brackets, matching a connector's normalised
 * `rfcMessageId`; the connector wraps it in `<…>` when writing the header. The
 * raw `draftId` is folded in via a hash so distinct drafts that sanitise to the
 * same slug still produce distinct ids (a collision would be a false dedup).
 */
export const deterministicReplyMessageId = (
  mailbox: string,
  draftId: string,
): string => {
  const at = mailbox.lastIndexOf("@");
  const domain =
    at >= 0 && at < mailbox.length - 1
      ? mailbox.slice(at + 1).trim().toLowerCase()
      : "support-agent.local";
  const slug =
    draftId
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 96) || "draft";
  return `sa-reply.${slug}.${fnv1a(draftId)}@${domain}`;
};

/**
 * What the runtime hands a connector to wait for a customer reply. The
 * agent pauses the ticket in `waiting_for_customer` after this is sent; the
 * eventual `customer.replied` event resumes the tick.
 *
 * Distinct from `ConversationReply` because `ask_customer` semantically
 * implies "block here until they respond" — that distinction matters for
 * SLA timers, follow-up scheduling, and audit log clarity.
 */
export interface AskCustomerDraft {
  readonly threadId: ThreadId;
  /** Exact connected mailbox that owns the thread. */
  readonly mailbox?: string;
  readonly to: ReadonlyArray<MessageParticipant>;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly attachments: ReadonlyArray<MessageAttachment>;
  readonly draftId: string;
  /** Optional follow-up SLA — connector or timer service may surface it. */
  readonly remindAfterHours?: number;
}

// ============================================================
// Errors
// ============================================================

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound")<{
  readonly threadId: ThreadId;
  readonly tenantId: TenantId;
}> {}

export class ConversationAuthMissing extends Data.TaggedError(
  "ConversationAuthMissing",
)<{
  readonly tenantId: TenantId;
  readonly provider: string;
}> {}

export class ConversationAuthFailed extends Data.TaggedError(
  "ConversationAuthFailed",
)<{
  readonly tenantId: TenantId;
  readonly provider: string;
}> {}

export class ConversationProviderUnavailable extends Data.TaggedError(
  "ConversationProviderUnavailable",
)<{
  readonly provider: string;
  readonly retryAfterMs?: number;
}> {}

export class ConversationSendFailed extends Data.TaggedError(
  "ConversationSendFailed",
)<{
  readonly draftId: string;
  readonly reason: string;
}> {}

export type ConversationError =
  | ThreadNotFound
  | ConversationAuthMissing
  | ConversationAuthFailed
  | ConversationProviderUnavailable
  | ConversationSendFailed;
