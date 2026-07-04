import { Context, Effect, Layer } from "effect";
import {
  ThreadNotFound,
  type AskCustomerDraft,
  type ConversationError,
  type ConversationReply,
  type ConversationThread,
  type SentMessage,
  type TenantId,
  type ThreadId,
} from "@support-agent/agent-core";

/**
 * Provider-neutral conversation surface. Every connector (Gmail, Outlook,
 * IMAP/SMTP, helpdesk products, marketing-message providers) implements
 * this Tag. The runtime, tools, and agents never reach behind it.
 *
 * Master-plan §6 (Effect Service Tags) + §20 ("never moves earlier")
 * make this contract load-bearing — the agent must stay connector-
 * agnostic. Adding a new provider means adding a new
 * `Layer.effect(ConversationService, ...)`, not changing this Tag or any
 * caller.
 *
 * `tenantId` is passed on every call so the Live implementation can
 * resolve per-tenant credentials through `ConnectorCredentialStore`.
 */
export class ConversationService extends Context.Tag("ConversationService")<
  ConversationService,
  {
    /**
     * Fetch the full message history of a thread, ordered oldest →
     * newest. Used by `conversation.fetch_thread` and by the runtime to
     * resume a paused ticket with surrounding context.
     */
    readonly fetchThread: (
      tenantId: TenantId,
      threadId: ThreadId,
      mailbox?: string,
    ) => Effect.Effect<ConversationThread, ConversationError>;

    /**
     * Send a customer-facing reply through the tenant's configured
     * connector. Idempotent on `(ticketId, draftId)` — the connector tracks
     * sends and returns the prior `SentMessage` on a re-attempt so a
     * runtime retry doesn't double-send (master-plan §9).
     */
    readonly reply: (
      tenantId: TenantId,
      input: ConversationReply,
    ) => Effect.Effect<SentMessage, ConversationError>;

    /**
     * Send a question to the customer and signal the workflow should
     * pause until `customer.replied` arrives. Distinct from `reply`
     * because the runtime transitions the ticket to `waiting_for_customer`
     * after this call and schedules any configured follow-up timer.
     */
    readonly askCustomer: (
      tenantId: TenantId,
      input: AskCustomerDraft,
    ) => Effect.Effect<SentMessage, ConversationError>;
  }
>() {}

/**
 * The service shape behind the `ConversationService` Tag. A connector's inner
 * builder returns this object (e.g. `makeGmailConversation`), so the
 * per-tenant router can hold several built impls in one Map and dispatch
 * between them — two `Layer`s can't both provide the same Tag, but plain
 * shapes compose freely.
 */
export type ConversationServiceShape = Context.Tag.Service<ConversationService>;

// ============================================================
// Test layer — in-memory, single-tenant, deterministic ids
// ============================================================

export interface ConversationTestFixtures {
  /**
   * Pre-seeded threads, keyed by `${tenantId}:${threadId}`. Tests that
   * exercise `fetchThread` against an unknown thread receive
   * `ThreadNotFound` exactly as a Live impl would.
   */
  readonly threads?: ReadonlyMap<string, ConversationThread>;
  /**
   * Optional clock override; useful when asserting `SentMessage.sentAt`.
   */
  readonly now?: () => Date;
  /**
   * Optional id minter for outgoing messages; defaults to incrementing
   * counters so assertions can pin against `"sent-1"`, `"sent-2"`, ...
   */
  readonly mintId?: () => string;
}

/**
 * In-memory ConversationService for unit tests. Records every `reply` /
 * `askCustomer` call in a public `sent` array so tests can assert on
 * what would have gone out over the wire without a real connector.
 *
 * The fixture is intentionally NOT idempotent on `(ticketId, draftId)` —
 * tests that care about idempotency assert it at the call-site (e.g.
 * "two replies with same draftId produce two recorded sends; the runtime
 * dedupes upstream"). Production Live impls MUST dedupe.
 */
export interface ConversationServiceTestHandle {
  /** Every outbound reply / askCustomer call, in the order they happened. */
  readonly sent: ReadonlyArray<{
    readonly kind: "reply" | "askCustomer";
    readonly tenantId: TenantId;
    readonly input: ConversationReply | AskCustomerDraft;
    readonly result: SentMessage;
  }>;
}

export const makeConversationServiceTest = (
  fixtures: ConversationTestFixtures = {},
): { readonly layer: Layer.Layer<ConversationService>; readonly handle: ConversationServiceTestHandle } => {
  const sent: Array<{
    kind: "reply" | "askCustomer";
    tenantId: TenantId;
    input: ConversationReply | AskCustomerDraft;
    result: SentMessage;
  }> = [];
  let counter = 0;
  const now = fixtures.now ?? (() => new Date());
  const mintId = fixtures.mintId ?? (() => `sent-${++counter}`);
  const threadKey = (t: TenantId, th: ThreadId) => `${t}:${th}`;

  const layer = Layer.succeed(
    ConversationService,
    ConversationService.of({
      fetchThread: (tenantId, threadId) => {
        const t = fixtures.threads?.get(threadKey(tenantId, threadId));
        return t
          ? Effect.succeed(t)
          : Effect.fail(new ThreadNotFound({ threadId, tenantId }));
      },
      reply: (tenantId, input) => {
        const result: SentMessage = {
          id: mintId(),
          threadId: input.threadId,
          sentAt: now(),
        };
        sent.push({ kind: "reply", tenantId, input, result });
        return Effect.succeed(result);
      },
      askCustomer: (tenantId, input) => {
        const result: SentMessage = {
          id: mintId(),
          threadId: input.threadId,
          sentAt: now(),
        };
        sent.push({ kind: "askCustomer", tenantId, input, result });
        return Effect.succeed(result);
      },
    }),
  );

  // Cast to ReadonlyArray for callers; mutation stays internal.
  const handle: ConversationServiceTestHandle = {
    get sent() {
      return sent;
    },
  };
  return { layer, handle };
};

/**
 * Convenience: when you only need the Layer (no fixture inspection).
 */
export const ConversationServiceTest = (
  fixtures: ConversationTestFixtures = {},
): Layer.Layer<ConversationService> =>
  makeConversationServiceTest(fixtures).layer;
