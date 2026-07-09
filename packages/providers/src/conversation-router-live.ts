import { Effect, Layer } from "effect";
import {
  ConversationAuthMissing,
  ConversationProviderUnavailable,
  ThreadNotFound,
  type ConversationError,
  type TenantId,
  type ThreadId,
} from "@support-agent/agent-core";
import {
  TicketRepository,
  BlobStorage,
  ConnectorCredentialStore,
  ConversationService,
  isConversationProvider,
  namespaceThreadId,
  parseThreadId,
  type ConnectorProvider,
  type ConversationProviderId,
  type ConversationServiceShape,
} from "@support-agent/services";

/**
 * Thread-routed conversation connector dispatcher.
 *
 * A tenant can hold SEVERAL conversation connectors at once — Gmail, Outlook,
 * and IMAP mailboxes all listening in parallel. Every thread id in the system
 * is namespaced by the provider that owns it (`gmail:<id>`, `outlook:<id>`,
 * `imap:<id>`; see `namespaceThreadId` in `@support-agent/services`), stamped
 * on at the inbound edge. This router parses that prefix, delegates to the
 * matching Live impl with the RAW provider id, and re-namespaces ids on the
 * way out — so replies always leave through the same mailbox the customer
 * wrote to. The runtime, tools, and agents see only the `ConversationService`
 * Tag and opaque ids; they never learn which provider answered.
 *
 * LEGACY thread ids (tickets created before namespacing landed) carry no
 * prefix. For those the optional `resolveLegacyProvider` hook supplies the
 * owning provider — `makeTicketProviderResolver` below reads the provider
 * stamped on the ticket row (audit D2), with the tenant's active conversation
 * connector as a last resort for unstamped rows. Legacy ids are passed to
 * the connector raw and stay un-namespaced on the way out, so the stored
 * ticket threadId keeps matching.
 *
 * Two `Layer`s can't both provide the same Tag, so each connector exposes its
 * inner builder (`make…Conversation(cfg): Effect<ConversationServiceShape, …>`)
 * instead of only a Layer. The router builds them all into one Map and
 * dispatches per call.
 */

/**
 * Resolves the owning conversation provider for a thread id that carries no
 * namespace prefix. `null` → nobody owns it (treated as ThreadNotFound).
 */
export type LegacyThreadProviderResolver = (
  tenantId: TenantId,
  threadId: ThreadId,
) => Effect.Effect<ConversationProviderId | null, ConversationError>;

/**
 * Build the router's service shape from a map of already-constructed connector
 * impls keyed by provider. Kept separate from {@link ConversationRouterLive} so
 * the dispatch logic is unit-testable with fake impls.
 */
export const makeConversationRouter = (
  impls: ReadonlyMap<ConnectorProvider, ConversationServiceShape>,
  resolveLegacyProvider?: LegacyThreadProviderResolver,
): ConversationServiceShape => {
  const dispatchTo = (
    tenantId: TenantId,
    threadId: ThreadId,
    provider: ConversationProviderId,
    raw: ThreadId,
    wrapId: (rawId: string) => ThreadId,
  ): Effect.Effect<
    {
      readonly impl: ConversationServiceShape;
      readonly provider: ConversationProviderId;
      readonly raw: ThreadId;
      readonly wrapId: (rawId: string) => ThreadId;
    },
    ConversationError
  > => {
    const impl = impls.get(provider);
    if (!impl) {
      return Effect.fail(new ConversationAuthMissing({ tenantId, provider }));
    }
    return Effect.succeed({ impl, provider, raw, wrapId });
  };

  const resolve = (
    tenantId: TenantId,
    threadId: ThreadId,
  ): Effect.Effect<
    {
      readonly impl: ConversationServiceShape;
      readonly provider: ConversationProviderId;
      readonly raw: ThreadId;
      /** Maps a connector-returned raw id back to the caller's id space. */
      readonly wrapId: (rawId: string) => ThreadId;
    },
    ConversationError
  > => {
    const parsed = parseThreadId(threadId);
    if (parsed) {
      return dispatchTo(tenantId, threadId, parsed.provider, parsed.raw, (id) =>
        namespaceThreadId(parsed.provider, id),
      );
    }
    // No / unknown prefix: a LEGACY id from before namespacing — route by the
    // ticket's stamped provider when a resolver is wired (audit D2). Without
    // one, this id can't belong to any connector we could dispatch to, which
    // is indistinguishable from the thread not existing.
    if (!resolveLegacyProvider) {
      return Effect.fail(new ThreadNotFound({ threadId, tenantId }));
    }
    return resolveLegacyProvider(tenantId, threadId).pipe(
      Effect.flatMap((provider) =>
        provider === null
          ? Effect.fail(new ThreadNotFound({ threadId, tenantId }))
          : // Legacy ids are stored raw and must STAY raw on the way out so
            // the ticket row keeps matching.
            dispatchTo(tenantId, threadId, provider, threadId, () => threadId),
      ),
    );
  };

  // Connectors fail with their RAW id; surface the namespaced one the caller
  // actually holds.
  const renameError =
    (tenantId: TenantId, threadId: ThreadId) =>
    (e: ConversationError): ConversationError =>
      e._tag === "ThreadNotFound"
        ? new ThreadNotFound({ threadId, tenantId })
        : e;

  return ConversationService.of({
    fetchThread: (tenantId, threadId, mailbox) =>
      resolve(tenantId, threadId).pipe(
        Effect.flatMap(({ impl, provider, raw, wrapId }) =>
          impl.fetchThread(tenantId, raw, mailbox).pipe(
            Effect.flatMap((thread) =>
              thread.id !== raw ||
              thread.messages.some((message) => message.threadId !== raw)
                ? Effect.fail(
                    new ConversationProviderUnavailable({ provider }),
                  )
                : Effect.succeed({
                    ...thread,
                    id: wrapId(thread.id),
                    messages: thread.messages.map((m) => ({
                      ...m,
                      threadId: wrapId(m.threadId),
                    })),
                  }),
            ),
            Effect.mapError(renameError(tenantId, threadId)),
          ),
        ),
      ),
    reply: (tenantId, input) =>
      resolve(tenantId, input.threadId).pipe(
        Effect.flatMap(({ impl, raw }) =>
          impl.reply(tenantId, { ...input, threadId: raw }).pipe(
            Effect.map((sent) => ({ ...sent, threadId: input.threadId })),
            Effect.mapError(renameError(tenantId, input.threadId)),
          ),
        ),
      ),
    askCustomer: (tenantId, input) =>
      resolve(tenantId, input.threadId).pipe(
        Effect.flatMap(({ impl, raw }) =>
          impl.askCustomer(tenantId, { ...input, threadId: raw }).pipe(
            Effect.map((sent) => ({ ...sent, threadId: input.threadId })),
            Effect.mapError(renameError(tenantId, input.threadId)),
          ),
        ),
      ),
  });
};

/**
 * Legacy-thread resolver backed by the ticket table (audit D2): the provider
 * stamped on the ticket that owns the thread wins; for unstamped rows (tickets
 * older than the stamp) fall back to the tenant's most recently installed
 * ACTIVE conversation connector — the only remaining signal. Repo/store
 * failures surface as `ConversationProviderUnavailable` (retryable) rather
 * than a misleading ThreadNotFound.
 *
 * Wire it as `ConversationRouterLive(builders, makeTicketProviderResolver)`;
 * the resulting Layer then also requires `TicketRepository`.
 */
export const makeTicketProviderResolver: Effect.Effect<
  LegacyThreadProviderResolver,
  never,
  TicketRepository | ConnectorCredentialStore
> = Effect.gen(function* () {
  const tickets = yield* TicketRepository;
  const store = yield* ConnectorCredentialStore;

  const unavailable = () =>
    new ConversationProviderUnavailable({ provider: "conversation-router" });

  return (tenantId, threadId) =>
    tickets.findThreadProvider(tenantId, threadId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((stamped) => {
        if (stamped !== null) return Effect.succeed(stamped);
        // Tenant-level fallback for unstamped legacy tickets: the most
        // recently installed active conversation connector, deterministic
        // by (installedAt DESC, provider ASC).
        return store.listForTenant(tenantId).pipe(
          Effect.mapError(unavailable),
          Effect.map((connections) => {
            const candidates = connections
              .filter(
                (c) =>
                  c.status === "active" && isConversationProvider(c.provider),
              )
              .sort(
                (a, b) =>
                  b.installedAt.getTime() - a.installedAt.getTime() ||
                  a.provider.localeCompare(b.provider),
              );
            const winner = candidates[0];
            return winner && isConversationProvider(winner.provider)
              ? winner.provider
              : null;
          }),
        );
      }),
    );
});

/**
 * Live `ConversationService` that dispatches per thread-id prefix. `builders`
 * pairs a provider with its inner builder Effect; the bootstrap supplies
 * whichever connectors the deployment has env for (e.g.
 * `["gmail", makeGmailConversation(cfg)]`). All builders share the same
 * `ConnectorCredentialStore` from context.
 *
 * Pass {@link makeTicketProviderResolver} as `legacyResolver` to route legacy
 * (un-namespaced) thread ids by the ticket's stamped provider (audit D2); the
 * Layer then additionally requires whatever the resolver needs (for the
 * ticket-stamp resolver: `TicketRepository`). Omitted → un-prefixed ids keep
 * failing ThreadNotFound, and existing call sites compile unchanged.
 */
export const ConversationRouterLive = <RFallback = never>(
  builders: ReadonlyArray<
    readonly [
      ConnectorProvider,
      Effect.Effect<
        ConversationServiceShape,
        never,
        ConnectorCredentialStore | BlobStorage
      >,
    ]
  >,
  legacyResolver?: Effect.Effect<
    LegacyThreadProviderResolver,
    never,
    RFallback | ConnectorCredentialStore
  >,
): Layer.Layer<
  ConversationService,
  never,
  ConnectorCredentialStore | BlobStorage | RFallback
> =>
  Layer.effect(
    ConversationService,
    Effect.gen(function* () {
      const impls = new Map<ConnectorProvider, ConversationServiceShape>();
      for (const [provider, builder] of builders) {
        impls.set(provider, yield* builder);
      }
      const resolveLegacy = legacyResolver ? yield* legacyResolver : undefined;
      return makeConversationRouter(impls, resolveLegacy);
    }),
  );
