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
  BlobStorage,
  ConnectorCredentialStore,
  ConversationService,
  type ConnectorConnection,
  type ConversationServiceShape,
} from "@support-agent/services";
import {
  buildThread,
  imapConfigFromConnection,
  makeImapSmtpOps,
  stripBrackets,
  type ImapSmtpConfig,
  type ImapSmtpOps,
  type RawImapMessage,
} from "./imap-smtp.js";
import { resolveOutboundAttachments } from "./outbound-attachments.js";
import { reportConnectorHealth } from "./connector-health.js";

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

const isAuthenticationFailure = (cause: unknown): boolean => {
  const reason =
    typeof cause === "object" && cause !== null && "reason" in cause
      ? String((cause as { readonly reason?: unknown }).reason ?? "")
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return /auth(?:entication)? failed|invalid (?:login|credentials)|bad credentials|\b535\b/iu.test(
    reason,
  );
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
): Effect.Effect<
  ConversationServiceShape,
  never,
  ConnectorCredentialStore | BlobStorage
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const blob = yield* BlobStorage;
    const opsFactory = cfg.opsFactory ?? makeImapSmtpOps;

    const resolve = (
      tenantId: TenantId,
      mailbox?: string,
    ): Effect.Effect<
      { ops: ImapSmtpOps; mailbox: string; connection: ConnectorConnection },
      ConversationError
    > =>
      Effect.gen(function* () {
        const conn = yield* store.get(tenantId, "imap", mailbox).pipe(
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
        return {
          ops: opsFactory(config),
          mailbox: conn.shopDomain,
          connection: conn,
        };
      });

    const fetchThread = (
      tenantId: TenantId,
      threadId: ThreadId,
      mailbox?: string,
    ): Effect.Effect<ConversationThread, ConversationError> =>
      Effect.gen(function* () {
        const resolved = yield* resolve(tenantId, mailbox);
        const raws = yield* Effect.tryPromise({
          try: () => resolved.ops.fetchThread(threadId),
          catch: (): ConversationError =>
            new ConversationProviderUnavailable({ provider: "imap" }),
        });
        if (raws.length === 0) {
          return yield* Effect.fail(new ThreadNotFound({ threadId, tenantId }));
        }
        return buildThread(raws, threadId, resolved.mailbox);
      });

    const send = (
      tenantId: TenantId,
      draft: ConversationReply | AskCustomerDraft,
    ): Effect.Effect<SentMessage, ConversationError> =>
      Effect.gen(function* () {
        const { ops, mailbox, connection } = yield* resolve(
          tenantId,
          draft.mailbox,
        );
        const root = String(draft.threadId);
        let subject = draft.subject;
        let inReplyTo =
          "inReplyToMessageId" in draft
            ? (draft.inReplyToMessageId ?? null)
            : null;

        // Read the thread ONLY when we lack the subject — the one thing we
        // can't reconstruct without it. The reply/ask_customer tools already
        // fetch the thread for their recipient check and pass the subject
        // down, so in the healthy path this read never happens (it's a second
        // connection to the same mailbox — real pressure on providers with a
        // low concurrent-connection cap). The parent (In-Reply-To) is left to
        // default below; a reply still threads via References=[root].
        //
        // This read is also BEST-EFFORT: a transient IMAP failure (connection
        // limit, timeout) must NOT block the SMTP send — losing the customer
        // reply is far worse than a generic subject. On a failed/empty read we
        // fall back to "Re: support" (at send) + References=[root]; threading
        // still holds via the recorded message-id index.
        if (!subject) {
          const raws = yield* Effect.tryPromise({
            try: () => ops.fetchThread(root),
            catch: (): ConversationError =>
              new ConversationProviderUnavailable({ provider: "imap" }),
          }).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<RawImapMessage>),
          );
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

        const attachments = yield* resolveOutboundAttachments(
          blob,
          draft.attachments,
          draft.draftId,
        );
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
              ...(attachments.length > 0 ? { attachments } : {}),
              idempotencyKey: draft.draftId,
            }),
          catch: (cause): ConversationError =>
            new ConversationSendFailed({
              draftId: draft.draftId,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.tap(() =>
            reportConnectorHealth(store, connection, "ok", null),
          ),
          Effect.tapError((error) =>
            isAuthenticationFailure(error)
              ? reportConnectorHealth(
                  store,
                  connection,
                  "broken",
                  "auth_failed",
                )
              : Effect.void,
          ),
        );
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
): Layer.Layer<
  ConversationService,
  never,
  ConnectorCredentialStore | BlobStorage
> => Layer.effect(ConversationService, makeImapSmtpConversation(cfg));
