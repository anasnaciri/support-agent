import { Effect, Layer } from "effect";
import {
  ConversationAuthMissing,
  ThreadNotFound,
  type ConversationError,
  type TenantId,
  type ThreadId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConversationService,
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
 * Two `Layer`s can't both provide the same Tag, so each connector exposes its
 * inner builder (`make…Conversation(cfg): Effect<ConversationServiceShape, …>`)
 * instead of only a Layer. The router builds them all into one Map and
 * dispatches per call.
 */

/**
 * Build the router's service shape from a map of already-constructed connector
 * impls keyed by provider. Kept separate from {@link ConversationRouterLive} so
 * the dispatch logic is unit-testable with fake impls.
 */
export const makeConversationRouter = (
  impls: ReadonlyMap<ConnectorProvider, ConversationServiceShape>,
): ConversationServiceShape => {
  const resolve = (
    tenantId: TenantId,
    threadId: ThreadId,
  ): Effect.Effect<
    {
      readonly impl: ConversationServiceShape;
      readonly provider: ConversationProviderId;
      readonly raw: ThreadId;
    },
    ConversationError
  > => {
    const parsed = parseThreadId(threadId);
    // No / unknown prefix: this id can't belong to any connector we could
    // ever dispatch to, which is indistinguishable from the thread not
    // existing.
    if (!parsed) return Effect.fail(new ThreadNotFound({ threadId, tenantId }));
    const impl = impls.get(parsed.provider);
    if (!impl) {
      return Effect.fail(
        new ConversationAuthMissing({ tenantId, provider: parsed.provider }),
      );
    }
    return Effect.succeed({ impl, provider: parsed.provider, raw: parsed.raw });
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
    fetchThread: (tenantId, threadId) =>
      resolve(tenantId, threadId).pipe(
        Effect.flatMap(({ impl, provider, raw }) =>
          impl.fetchThread(tenantId, raw).pipe(
            Effect.map((thread) => ({
              ...thread,
              id: namespaceThreadId(provider, thread.id),
              messages: thread.messages.map((m) => ({
                ...m,
                threadId: namespaceThreadId(provider, m.threadId),
              })),
            })),
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
 * Live `ConversationService` that dispatches per thread-id prefix. `builders`
 * pairs a provider with its inner builder Effect; the bootstrap supplies
 * whichever connectors the deployment has env for (e.g.
 * `["gmail", makeGmailConversation(cfg)]`). All builders share the same
 * `ConnectorCredentialStore` from context.
 */
export const ConversationRouterLive = (
  builders: ReadonlyArray<
    readonly [
      ConnectorProvider,
      Effect.Effect<ConversationServiceShape, never, ConnectorCredentialStore>,
    ]
  >,
): Layer.Layer<ConversationService, never, ConnectorCredentialStore> =>
  Layer.effect(
    ConversationService,
    Effect.gen(function* () {
      const impls = new Map<ConnectorProvider, ConversationServiceShape>();
      for (const [provider, builder] of builders) {
        impls.set(provider, yield* builder);
      }
      return makeConversationRouter(impls);
    }),
  );
