import { Effect, Layer } from "effect";
import {
  ConversationAuthMissing,
  ConversationProviderUnavailable,
  ConversationSendFailed,
  ThreadNotFound,
  type AskCustomerDraft,
  type ConversationError,
  type ConversationReply,
  type ConversationThread,
  type SentMessage,
  type TenantId,
  type ThreadId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConversationService,
  type ConversationServiceShape,
} from "@support-agent/services";
import {
  buildThread,
  imapConfigFromConnection,
  makeImapSmtpOps,
  stripBrackets,
  type ImapSmtpConfig,
  type ImapSmtpOps,
} from "./imap-smtp.js";

// ============================================================
// Provider config (boot-time)
// ============================================================

export interface ImapSmtpProviderConfig {
  /**
   * Factory for the IMAP/SMTP ops, given a tenant's resolved connection
   * config. Defaults to the live `makeImapSmtpOps`; tests inject a fake.
   */
  readonly opsFactory?: (config: ImapSmtpConfig) => ImapSmtpOps;
}

const replySubject = (subject: string): string => {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: support";
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`;
};

// ============================================================
// Builder + Live Layer
// ============================================================

/**
 * Inner builder for the generic IMAP/SMTP `ConversationService` impl — the
 * universal catch-all for any mailbox that isn't Gmail or Microsoft. Resolves
 * per-tenant credentials via `ConnectorCredentialStore` under provider
 * `"imap"`, connects per operation, and maps failures into the
 * provider-neutral `ConversationError` union. Used directly by the router.
 */
export const makeImapSmtpConversation = (
  cfg: ImapSmtpProviderConfig = {},
): Effect.Effect<ConversationServiceShape, never, ConnectorCredentialStore> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const opsFactory = cfg.opsFactory ?? makeImapSmtpOps;

    const resolve = (
      tenantId: TenantId,
    ): Effect.Effect<{ ops: ImapSmtpOps; mailbox: string }, ConversationError> =>
      Effect.gen(function* () {
        const conn = yield* store.get(tenantId, "imap").pipe(
          Effect.mapError(
            (): ConversationError =>
              new ConversationAuthMissing({ tenantId, provider: "imap" }),
          ),
        );
        const config = imapConfigFromConnection(conn);
        if (!config) {
          return yield* Effect.fail(
            new ConversationAuthMissing({ tenantId, provider: "imap" }),
          );
        }
        return { ops: opsFactory(config), mailbox: conn.shopDomain };
      });

    const fetchThread = (
      tenantId: TenantId,
      threadId: ThreadId,
    ): Effect.Effect<ConversationThread, ConversationError> =>
      Effect.gen(function* () {
        const { ops, mailbox } = yield* resolve(tenantId);
        const raws = yield* Effect.tryPromise({
          try: () => ops.fetchThread(threadId),
          catch: (): ConversationError =>
            new ConversationProviderUnavailable({ provider: "imap" }),
        });
        if (raws.length === 0) {
          return yield* Effect.fail(new ThreadNotFound({ threadId, tenantId }));
        }
        return buildThread(raws, threadId, mailbox);
      });

    const send = (
      tenantId: TenantId,
      draft: ConversationReply | AskCustomerDraft,
    ): Effect.Effect<SentMessage, ConversationError> =>
      Effect.gen(function* () {
        const { ops, mailbox } = yield* resolve(tenantId);
        const root = String(draft.threadId);
        let subject = draft.subject;
        let inReplyTo =
          "inReplyToMessageId" in draft
            ? (draft.inReplyToMessageId ?? null)
            : null;

        // Derive the subject and the immediate parent message when not given,
        // by reading the thread once.
        if (!subject || inReplyTo === null) {
          const raws = yield* Effect.tryPromise({
            try: () => ops.fetchThread(root),
            catch: (): ConversationError =>
              new ConversationSendFailed({
                draftId: draft.draftId,
                reason: "could not read thread for reply context",
              }),
          });
          if (raws.length > 0) {
            const thread = buildThread(raws, root, mailbox);
            subject ??= replySubject(thread.subject);
            const last = thread.messages.at(-1);
            inReplyTo ??= last ? last.id : root;
          }
        }
        const normalisedInReplyTo = inReplyTo ? stripBrackets(inReplyTo) : null;
        const references =
          normalisedInReplyTo && normalisedInReplyTo !== root
            ? [root, normalisedInReplyTo]
            : [root];

        const sent = yield* Effect.tryPromise({
          try: () =>
            ops.send({
              from: { name: null, email: mailbox },
              to: draft.to,
              subject: subject ?? "Re: support",
              text: draft.bodyText,
              html: draft.bodyHtml,
              inReplyTo: normalisedInReplyTo,
              references,
            }),
          catch: (cause): ConversationError =>
            new ConversationSendFailed({
              draftId: draft.draftId,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        return {
          id: sent.messageId,
          threadId: draft.threadId,
          sentAt: new Date(),
        };
      });

    return ConversationService.of({
      fetchThread,
      reply: (tenantId, input) => send(tenantId, input),
      askCustomer: (tenantId, input) => send(tenantId, input),
    });
  });

/**
 * Live `ConversationService` over generic IMAP/SMTP as a standalone Layer — a
 * thin wrapper over {@link makeImapSmtpConversation}. The router uses the
 * builder directly.
 */
export const ImapSmtpConversationLive = (
  cfg: ImapSmtpProviderConfig = {},
): Layer.Layer<ConversationService, never, ConnectorCredentialStore> =>
  Layer.effect(ConversationService, makeImapSmtpConversation(cfg));
