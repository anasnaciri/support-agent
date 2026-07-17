import { Effect, Layer } from "effect";
import {
  ConversationAuthFailed,
  ConversationAuthMissing,
  ConversationProviderUnavailable,
  ConversationSendFailed,
  deterministicReplyMessageId,
  ThreadNotFound,
  type AskCustomerDraft,
  type ConversationError,
  type ConversationMessage,
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
import { resolveOutboundAttachments } from "./outbound-attachments.js";
import {
  buildGmailMime,
  GmailHttpError,
  gmailGetThread,
  gmailSendMessage,
} from "./gmail-http.js";
import { refreshGmailToken } from "./gmail-token.js";
import { reportConnectorHealth } from "./connector-health.js";

// ============================================================
// Provider config (boot-time)
// ============================================================

export interface GmailProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Optional fetch override — primarily for tests; production uses global
   * `fetch`. Passed through into `gmail-http` and `gmail-token` on every call.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Buffer subtracted from `tokenExpiresAt` when deciding to pre-emptively
   * refresh, so we don't race the clock on a borderline-expired token.
   * Defaults to 60 seconds.
   */
  readonly refreshSkewMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

const replySubject = (subject: string): string => {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: support";
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`;
};

// ============================================================
// Error mapping
// ============================================================

const mapHttpError = (
  err: unknown,
  ctx: { tenantId: TenantId; threadId?: ThreadId; draftId?: string },
): ConversationError => {
  if (err instanceof GmailHttpError) {
    const f = err.failure;
    if (f.kind === "auth_failed") {
      return new ConversationAuthFailed({
        tenantId: ctx.tenantId,
        provider: "gmail",
      });
    }
    if (f.kind === "rate_limited") {
      return new ConversationProviderUnavailable({
        provider: "gmail",
        retryAfterMs: f.retryAfterMs,
      });
    }
    if (f.kind === "not_found" && ctx.threadId) {
      return new ThreadNotFound({
        threadId: ctx.threadId,
        tenantId: ctx.tenantId,
      });
    }
    if (ctx.draftId) {
      return new ConversationSendFailed({
        draftId: ctx.draftId,
        reason: err.message,
      });
    }
    return new ConversationProviderUnavailable({ provider: "gmail" });
  }
  if (ctx.draftId) {
    return new ConversationSendFailed({
      draftId: ctx.draftId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return new ConversationProviderUnavailable({ provider: "gmail" });
};

// ============================================================
// Live Layer
// ============================================================

/**
 * Live `ConversationService` over Gmail. Resolves per-tenant tokens via
 * `ConnectorCredentialStore`, refreshes them on expiry / 401, and maps
 * Gmail HTTP failures into the provider-neutral `ConversationError`
 * union. The agent runtime + tools see no Gmail-specific surface — they
 * yield `ConversationService` and get a `ConversationThread` /
 * `SentMessage` back.
 */
export const makeGmailConversation = (
  cfg: GmailProviderConfig,
): Effect.Effect<
  ConversationServiceShape,
  never,
  ConnectorCredentialStore | BlobStorage
> =>
  Effect.gen(function* () {
      const store = yield* ConnectorCredentialStore;
      const blob = yield* BlobStorage;
      const skew = cfg.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

      // Fetch the live token, refreshing first if expired (or close to).
      // Returns the freshest known access token + the connection record so
      // callers can derive the mailbox address for outbound `From`.
      const resolveToken = (tenantId: TenantId, mailbox?: string) =>
        Effect.gen(function* () {
          const conn = yield* store
            .get(tenantId, "gmail", mailbox)
            .pipe(
              Effect.mapError(
                (): ConversationError =>
                  new ConversationAuthMissing({
                    tenantId,
                    provider: "gmail",
                  }),
              ),
            );
          if (!conn.refreshToken) {
            return yield* Effect.fail(
              new ConversationAuthMissing({
                tenantId,
                provider: "gmail",
              }),
            );
          }
          const expiresAt = conn.tokenExpiresAt;
          const expired =
            expiresAt === null || expiresAt.getTime() - skew < Date.now();
          if (!expired) {
            return conn;
          }
          // Refresh.
          const refreshed = yield* Effect.tryPromise({
            try: () =>
              refreshGmailToken({
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                refreshToken: conn.refreshToken!,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause): ConversationError =>
              new ConversationAuthFailed({
                tenantId,
                provider: "gmail",
              }) as unknown as ConversationError &
                NonNullable<{ readonly _cause?: unknown }>,
          }).pipe(
            Effect.tap((tok) =>
              Effect.logDebug?.(`[gmail] refreshed token (exp ${tok.expiresAt.toISOString()})`) ??
              Effect.void,
            ),
            Effect.tapError(() =>
              reportConnectorHealth(store, conn, "broken", "auth_failed"),
            ),
          );
          const patched = yield* store
            .patchTokens({
              tenantId,
              provider: "gmail",
              shopDomain: conn.shopDomain,
              accessToken: refreshed.accessToken,
              tokenExpiresAt: refreshed.expiresAt,
            })
            .pipe(
              Effect.mapError(
                (): ConversationError =>
                  new ConversationAuthFailed({
                    tenantId,
                    provider: "gmail",
                  }),
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
              gmailGetThread({
                token: conn.accessToken,
                threadId,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) => mapHttpError(cause, { tenantId, threadId }),
          }).pipe(
            Effect.tap(() => reportConnectorHealth(store, conn, "ok", null)),
            Effect.tapError((error) =>
              error instanceof ConversationAuthFailed
                ? reportConnectorHealth(store, conn, "broken", "auth_failed")
                : Effect.void,
            ),
          );
          return {
            id: thread.id,
            subject: thread.subject,
            participants: thread.participants,
            messages: thread.messages,
          };
        });

      const send = (
        tenantId: TenantId,
        draft: ConversationReply | AskCustomerDraft,
        inReplyTo: string | null,
      ): Effect.Effect<SentMessage, ConversationError> =>
        Effect.gen(function* () {
          const conn = yield* resolveToken(tenantId, draft.mailbox);
          let subject = draft.subject;
          let inReplyToMessageId = inReplyTo;
          let references: ReadonlyArray<string> = [];

          // Deterministic outbound Message-ID for this exact draft (H8). We
          // both stamp it on the send AND scan the thread for it below, so a
          // crash between the send and the runtime's "sent" marker commit does
          // not double-send on redelivery.
          const dedupMessageId = deterministicReplyMessageId(
            conn.shopDomain,
            draft.draftId,
          );

          // Fetch the thread once — used for the idempotency scan and (when the
          // caller didn't supply them) to derive the subject + threading
          // headers. When those are genuinely NEEDED, a fetch failure is hard
          // (unchanged behavior). When they were already supplied, the fetch is
          // purely for dedup and fails OPEN: a read error must never block — or
          // suppress a retry of — a legitimate send.
          const threadNeeded = !subject || !inReplyToMessageId;
          const threadEither = yield* Effect.tryPromise({
            try: () =>
              gmailGetThread({
                token: conn.accessToken,
                threadId: draft.threadId,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) =>
              mapHttpError(cause, {
                tenantId,
                threadId: draft.threadId,
                draftId: draft.draftId,
              }),
          }).pipe(
            Effect.tap(() => reportConnectorHealth(store, conn, "ok", null)),
            Effect.tapError((error) =>
              error instanceof ConversationAuthFailed
                ? reportConnectorHealth(store, conn, "broken", "auth_failed")
                : Effect.void,
            ),
            Effect.either,
          );
          if (threadEither._tag === "Left") {
            if (threadNeeded) {
              return yield* Effect.fail(threadEither.left);
            }
          }
          const thread =
            threadEither._tag === "Right" ? threadEither.right : null;

          // Idempotent send: our own prior delivery of this draft is already in
          // the thread — return it instead of sending again. Matches only OUR
          // deterministic id, so a scan that finds nothing simply falls through
          // and sends (a genuine retry is never lost).
          if (thread) {
            const prior = thread.messages.find(
              (m) => m.rfcMessageId === dedupMessageId,
            );
            if (prior) {
              return {
                id: prior.id,
                threadId: draft.threadId,
                sentAt: prior.sentAt,
              };
            }
          }

          if (thread && threadNeeded) {
            subject ??= replySubject(thread.subject);
            const rfcIds = thread.messages
              .map((m) => m.rfcMessageId)
              .filter((id): id is string => id !== null);
            references = rfcIds;
            inReplyToMessageId ??= rfcIds.at(-1) ?? null;
          }

          const attachments = yield* resolveOutboundAttachments(
            blob,
            draft.attachments,
            draft.draftId,
          );
          const mime = buildGmailMime({
            from: { name: null, email: conn.shopDomain },
            to: draft.to,
            subject: subject ?? "Re: support",
            bodyText: draft.bodyText,
            bodyHtml: draft.bodyHtml,
            inReplyToMessageId,
            references,
            messageId: dedupMessageId,
            attachments,
          });
          const result = yield* Effect.tryPromise({
            try: () =>
              gmailSendMessage({
                token: conn.accessToken,
                raw: mime,
                threadId: draft.threadId,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) =>
              mapHttpError(cause, {
                tenantId,
                threadId: draft.threadId,
                draftId: draft.draftId,
              }),
          }).pipe(
            Effect.tap(() => reportConnectorHealth(store, conn, "ok", null)),
            Effect.tapError((error) =>
              error instanceof ConversationAuthFailed
                ? reportConnectorHealth(store, conn, "broken", "auth_failed")
                : Effect.void,
            ),
          );
          return {
            id: result.messageId,
            threadId: draft.threadId,
            sentAt: new Date(),
          };
        });

      const reply = (
        tenantId: TenantId,
        input: ConversationReply,
      ): Effect.Effect<SentMessage, ConversationError> =>
        send(tenantId, input, input.inReplyToMessageId);

      const askCustomer = (
        tenantId: TenantId,
        input: AskCustomerDraft,
      ): Effect.Effect<SentMessage, ConversationError> =>
        // `askCustomer` is a fresh outbound on the same thread — no
        // `In-Reply-To` because Gmail will derive the threading from the
        // `threadId` we pass to `users.messages.send`.
        send(tenantId, input, null);

      // Surface for diagnostics so the value-returning Effect compiles
      // cleanly; suppress unused warnings on the helper above.
      void ((): ConversationMessage | undefined => undefined)();

      return ConversationService.of({
        fetchThread,
        reply,
        askCustomer,
      });
    });

/**
 * Live `ConversationService` over Gmail as a standalone Layer — a thin wrapper
 * over {@link makeGmailConversation}. The per-tenant router uses the builder
 * directly; this Layer is for single-connector deployments / existing wiring.
 */
export const GmailConversationLive = (
  cfg: GmailProviderConfig,
): Layer.Layer<
  ConversationService,
  never,
  ConnectorCredentialStore | BlobStorage
> => Layer.effect(ConversationService, makeGmailConversation(cfg));
