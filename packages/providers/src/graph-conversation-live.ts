import { Effect, Layer } from "effect";
import {
  ConversationAuthFailed,
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
  type ConversationServiceShape,
} from "@support-agent/services";
import {
  GraphHttpError,
  graphAddDraftAttachment,
  graphCreateReplyDraft,
  graphGetConversation,
  graphSendDraft,
  graphUpdateDraftBody,
} from "./graph-http.js";
import { resolveOutboundAttachments } from "./outbound-attachments.js";
import { refreshGraphToken } from "./graph-token.js";

// ============================================================
// Provider config (boot-time)
// ============================================================

export interface GraphProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Azure AD tenant for token refresh. Defaults to "common". */
  readonly tenant?: string;
  /** Test-only fetch override; production uses global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Pre-emptive refresh buffer subtracted from expiry. Defaults to 60s. */
  readonly refreshSkewMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

// ============================================================
// Error mapping
// ============================================================

const mapHttpError = (
  err: unknown,
  ctx: { tenantId: TenantId; threadId?: ThreadId; draftId?: string },
): ConversationError => {
  if (err instanceof GraphHttpError) {
    const f = err.failure;
    if (f.kind === "auth_failed") {
      return new ConversationAuthFailed({ tenantId: ctx.tenantId, provider: "outlook" });
    }
    if (f.kind === "rate_limited") {
      return new ConversationProviderUnavailable({
        provider: "outlook",
        retryAfterMs: f.retryAfterMs,
      });
    }
    if (f.kind === "not_found" && ctx.threadId) {
      return new ThreadNotFound({ threadId: ctx.threadId, tenantId: ctx.tenantId });
    }
    if (ctx.draftId) {
      return new ConversationSendFailed({ draftId: ctx.draftId, reason: err.message });
    }
    return new ConversationProviderUnavailable({ provider: "outlook" });
  }
  if (ctx.draftId) {
    return new ConversationSendFailed({
      draftId: ctx.draftId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return new ConversationProviderUnavailable({ provider: "outlook" });
};

// ============================================================
// Builder + Live Layer
// ============================================================

/**
 * Inner builder for the Graph `ConversationService` impl (Outlook / O365 /
 * Exchange Online). Resolves per-tenant tokens via `ConnectorCredentialStore`
 * under provider `"outlook"`, refreshes on expiry (persisting Microsoft's
 * ROTATED refresh token), and maps Graph HTTP failures into the
 * provider-neutral `ConversationError` union. The runtime/tools never see
 * Graph-specific surface. Used directly by the conversation router.
 */
export const makeGraphConversation = (
  cfg: GraphProviderConfig,
): Effect.Effect<
  ConversationServiceShape,
  never,
  ConnectorCredentialStore | BlobStorage
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const blob = yield* BlobStorage;
    const skew = cfg.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

    // Freshest access token + the connection record (for the mailbox address).
    const resolveToken = (tenantId: TenantId, mailbox?: string) =>
      Effect.gen(function* () {
        const conn = yield* store.get(tenantId, "outlook", mailbox).pipe(
          Effect.mapError(
            (): ConversationError =>
              new ConversationAuthMissing({ tenantId, provider: "outlook" }),
          ),
        );
        if (!conn.refreshToken) {
          return yield* Effect.fail(
            new ConversationAuthMissing({ tenantId, provider: "outlook" }),
          );
        }
        const expiresAt = conn.tokenExpiresAt;
        const expired =
          expiresAt === null || expiresAt.getTime() - skew < Date.now();
        if (!expired) return conn;

        const refreshed = yield* Effect.tryPromise({
          try: () =>
            refreshGraphToken({
              clientId: cfg.clientId,
              clientSecret: cfg.clientSecret,
              refreshToken: conn.refreshToken!,
              ...(cfg.tenant ? { tenant: cfg.tenant } : {}),
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (): ConversationError =>
            new ConversationAuthFailed({ tenantId, provider: "outlook" }),
        });
        const patched = yield* store
          .patchTokens({
            tenantId,
            provider: "outlook",
            shopDomain: conn.shopDomain,
            accessToken: refreshed.accessToken,
            tokenExpiresAt: refreshed.expiresAt,
            // Microsoft rotates the refresh token; persist the new one. When
            // absent, omit so the store keeps the existing token.
            ...(refreshed.refreshToken !== null
              ? { refreshToken: refreshed.refreshToken }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (): ConversationError =>
                new ConversationAuthFailed({ tenantId, provider: "outlook" }),
            ),
          );
        return patched;
      });

    const fetchThread = (
      tenantId: TenantId,
      threadId: ThreadId,
      mailbox?: string,
    ): Effect.Effect<ConversationThread, ConversationError> =>
      Effect.gen(function* () {
        const conn = yield* resolveToken(tenantId, mailbox);
        const thread = yield* Effect.tryPromise({
          try: () =>
            graphGetConversation({
              token: conn.accessToken,
              conversationId: threadId,
              mailbox: conn.shopDomain,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) => mapHttpError(cause, { tenantId, threadId }),
        });
        if (thread.messages.length === 0) {
          return yield* Effect.fail(new ThreadNotFound({ threadId, tenantId }));
        }
        return thread;
      });

    // Both reply and askCustomer are outbound on an existing conversation —
    // Graph keeps threading via `createReply`. It replies to the selected
    // message's sender, so the target must be the most recent inbound message:
    // selecting our own latest outbound message creates a self-addressed draft.
    const send = (
      tenantId: TenantId,
      draft: ConversationReply | AskCustomerDraft,
    ): Effect.Effect<SentMessage, ConversationError> =>
      Effect.gen(function* () {
        const conn = yield* resolveToken(tenantId, draft.mailbox);
        const thread = yield* Effect.tryPromise({
          try: () =>
            graphGetConversation({
              token: conn.accessToken,
              conversationId: draft.threadId,
              mailbox: conn.shopDomain,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) =>
            mapHttpError(cause, {
              tenantId,
              threadId: draft.threadId,
              draftId: draft.draftId,
            }),
        });
        const latestInbound = thread.messages.slice().reverse().find(
          (message) => message.direction === "inbound",
        );
        if (!latestInbound) {
          return yield* Effect.fail(
            new ConversationSendFailed({
              draftId: draft.draftId,
              reason: "no inbound message to reply to in conversation",
            }),
          );
        }
        const created = yield* Effect.tryPromise({
          try: () =>
            graphCreateReplyDraft({
              token: conn.accessToken,
              messageId: latestInbound.id,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) =>
            mapHttpError(cause, { tenantId, threadId: draft.threadId, draftId: draft.draftId }),
        });
        yield* Effect.tryPromise({
          try: () =>
            graphUpdateDraftBody({
              token: conn.accessToken,
              draftId: created.id,
              bodyText: draft.bodyText,
              bodyHtml: draft.bodyHtml,
              to: draft.to,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) =>
            mapHttpError(cause, { tenantId, threadId: draft.threadId, draftId: draft.draftId }),
        });
        // Attachments go on the draft BEFORE the send — resolve every blob
        // first so a missing one fails the send without a half-attached draft
        // going out.
        const attachments = yield* resolveOutboundAttachments(
          blob,
          draft.attachments,
          draft.draftId,
        );
        yield* Effect.forEach(attachments, (attachment) =>
          Effect.tryPromise({
            try: () =>
              graphAddDraftAttachment({
                token: conn.accessToken,
                draftId: created.id,
                filename: attachment.filename,
                contentType: attachment.contentType,
                bytes: attachment.bytes,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) =>
              mapHttpError(cause, { tenantId, threadId: draft.threadId, draftId: draft.draftId }),
          }),
        );
        yield* Effect.tryPromise({
          try: () =>
            graphSendDraft({
              token: conn.accessToken,
              draftId: created.id,
              ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
            }),
          catch: (cause) =>
            mapHttpError(cause, { tenantId, threadId: draft.threadId, draftId: draft.draftId }),
        });
        return {
          id: created.id,
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
 * Live `ConversationService` over Microsoft Graph as a standalone Layer — a
 * thin wrapper over {@link makeGraphConversation}. The per-tenant router uses
 * the builder directly.
 */
export const GraphConversationLive = (
  cfg: GraphProviderConfig,
): Layer.Layer<
  ConversationService,
  never,
  ConnectorCredentialStore | BlobStorage
> => Layer.effect(ConversationService, makeGraphConversation(cfg));
