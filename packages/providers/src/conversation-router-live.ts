import { Effect, Layer } from "effect";
import {
  ConversationAuthMissing,
  type ConversationError,
  type TenantId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConversationService,
  type ConnectorProvider,
  type ConversationServiceShape,
} from "@support-agent/services";

/**
 * Per-tenant conversation connector router.
 *
 * The worker boots ONE `ConversationService` for the whole deployment, but in
 * a multi-tenant SaaS each merchant connects their own mailbox — one on Gmail,
 * another on Outlook, a third on a generic IMAP/SMTP host. This router resolves
 * which connector a tenant installed (from `connector_connections`) and
 * delegates to the matching Live impl. The runtime, tools, and agents see only
 * the `ConversationService` Tag — they never learn which provider answered.
 *
 * Two `Layer`s can't both provide the same Tag, so each connector exposes its
 * inner builder (`make…Conversation(cfg): Effect<ConversationServiceShape, …>`)
 * instead of only a Layer. The router builds them all into one Map and
 * dispatches per call.
 */

/**
 * Build the router's service shape from a map of already-constructed connector
 * impls keyed by provider. Kept separate from {@link ConversationRouterLive} so
 * the dispatch logic is unit-testable with fake impls + a seeded store.
 */
export const makeConversationRouter = (
  impls: ReadonlyMap<ConnectorProvider, ConversationServiceShape>,
): Effect.Effect<ConversationServiceShape, never, ConnectorCredentialStore> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;

    // Resolve the connector impl for a tenant: the most recently installed
    // active connection whose provider we actually have an impl for. Any
    // non-conversation connector (Shopify, LLM providers) is naturally
    // excluded because it isn't a key in `impls`.
    const resolve = (
      tenantId: TenantId,
    ): Effect.Effect<ConversationServiceShape, ConversationError> =>
      store.listForTenant(tenantId).pipe(
        Effect.mapError(
          (): ConversationError =>
            new ConversationAuthMissing({ tenantId, provider: "conversation" }),
        ),
        Effect.flatMap((conns) => {
          const chosen = conns
            .filter((c) => c.status === "active" && impls.has(c.provider))
            .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime())[0];
          return chosen
            ? Effect.succeed(impls.get(chosen.provider)!)
            : Effect.fail(
                new ConversationAuthMissing({
                  tenantId,
                  provider: "conversation",
                }),
              );
        }),
      );

    return ConversationService.of({
      fetchThread: (tenantId, threadId) =>
        resolve(tenantId).pipe(
          Effect.flatMap((impl) => impl.fetchThread(tenantId, threadId)),
        ),
      reply: (tenantId, input) =>
        resolve(tenantId).pipe(Effect.flatMap((impl) => impl.reply(tenantId, input))),
      askCustomer: (tenantId, input) =>
        resolve(tenantId).pipe(
          Effect.flatMap((impl) => impl.askCustomer(tenantId, input)),
        ),
    });
  });

/**
 * Live `ConversationService` that dispatches per tenant. `builders` pairs a
 * provider with its inner builder Effect; the bootstrap supplies whichever
 * connectors the deployment has env for (e.g. `["gmail", makeGmailConversation(cfg)]`).
 * All builders share the same `ConnectorCredentialStore` from context.
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
      return yield* makeConversationRouter(impls);
    }),
  );
