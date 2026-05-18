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
 * runtime to resume a paused case and by the `conversation.fetch_thread`
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
 * tick MUST NOT cause a duplicate send. Connectors track `(caseId,
 * draftId)` and return the prior `SentMessage` on a re-attempt.
 */
export interface ConversationReply {
  readonly threadId: ThreadId;
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
 * `inReplyToMessageId`) threads back to the right case.
 */
export interface SentMessage {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly sentAt: Date;
}

/**
 * What the runtime hands a connector to wait for a customer reply. The
 * agent pauses the case in `waiting_for_customer` after this is sent; the
 * eventual `customer.replied` event resumes the tick.
 *
 * Distinct from `ConversationReply` because `ask_customer` semantically
 * implies "block here until they respond" — that distinction matters for
 * SLA timers, follow-up scheduling, and audit log clarity.
 */
export interface AskCustomerDraft {
  readonly threadId: ThreadId;
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
