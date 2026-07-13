import { Context, Data, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import {
  type AgentId,
  type Ticket,
  type TicketChannel,
  type TicketContext,
  type TicketId,
  type TicketPriority,
  type TicketStatus,
  type CustomerId,
  type OrderId,
  type TenantId,
  type ThreadId,
  TicketId as makeTicketId,
  isStatusTransitionAllowed,
} from "@support-agent/agent-core";
import {
  parseThreadId,
  type ConversationProviderId,
} from "./conversation-thread-id.js";

// ============================================================
// Errors
// ============================================================

export class TicketNotFound extends Data.TaggedError("TicketNotFound")<{
  readonly ticketId: TicketId;
}> {}

export class TicketStateConflict extends Data.TaggedError("TicketStateConflict")<{
  readonly ticketId: TicketId;
  readonly expected: TicketStatus;
  readonly actual: TicketStatus;
}> {}

export class TicketRepositoryDbError extends Data.TaggedError(
  "TicketRepositoryDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * The requested status change violates the ticket state machine
 * (master-plan §10, audit L1) — e.g. resolving a ticket a manager has
 * taken over. Callers re-read the ticket and respect the current owner.
 */
export class InvalidStatusTransition extends Data.TaggedError(
  "InvalidStatusTransition",
)<{
  readonly ticketId: TicketId;
  readonly from: TicketStatus;
  readonly to: TicketStatus;
}> {}

export type TicketRepositoryError =
  | TicketNotFound
  | TicketStateConflict
  | InvalidStatusTransition
  | TicketRepositoryDbError;

// ============================================================
// Inputs
// ============================================================

export interface CreateTicketInput {
  readonly tenantId: TenantId;
  readonly channel: TicketChannel;
  readonly currentAgentId: AgentId;
  readonly customerId?: CustomerId | null;
  readonly orderId?: OrderId | null;
  readonly threadId?: ThreadId | null;
  /** Exact connected mailbox that owns `threadId`. */
  readonly mailbox?: string | null;
  /**
   * Conversation connector that owns `threadId` (audit D2). When omitted it
   * is derived from a provider-namespaced `threadId` (`gmail:…`); pass it
   * explicitly when the inbound edge knows the provider (always preferred).
   */
  readonly provider?: ConversationProviderId | null;
  readonly priority?: TicketPriority;
  readonly status?: TicketStatus;
  readonly subject?: string | null;
  readonly summary?: string | null;
  readonly context?: TicketContext;
}

/**
 * Provider stamp for a new ticket: the explicit input wins; otherwise it is
 * derived from a namespaced threadId. Shared by the Live and Test impls so
 * they can't drift.
 */
export const resolveTicketProvider = (
  input: Pick<CreateTicketInput, "provider" | "threadId">,
): ConversationProviderId | null => {
  if (input.provider !== undefined && input.provider !== null) {
    return input.provider;
  }
  if (input.threadId) return parseThreadId(input.threadId)?.provider ?? null;
  return null;
};

/**
 * Fields callers may patch via `update`. `status` is intentionally excluded —
 * status changes MUST flow through `transitionStatus` so the
 * `case_state_transitions` row is written atomically (master-plan §10).
 */
export type UpdatableTicketFields = Partial<
  Pick<
    Ticket,
    | "customerId"
    | "orderId"
    | "threadId"
    | "mailbox"
    | "currentAgentId"
    | "priority"
    | "subject"
    | "summary"
    | "context"
    | "epoch"
  >
>;

export interface TransitionStatusOptions {
  readonly expectedFromStatus?: TicketStatus;
  readonly eventId?: string;
  readonly reason?: string;
  /**
   * Defense-in-depth tenant scope (audit D9): when present, a ticket outside
   * the tenant is treated as not found and nothing is written.
   */
  readonly tenantId?: TenantId;
}

// ============================================================
// Tag
// ============================================================

/**
 * `tenantId` on the bare-id methods (`getById`/`update`/`transitionStatus`
 * via opts) is OPTIONAL for caller compatibility but ENFORCED when present
 * (audit D9): a ticket that exists under another tenant behaves exactly like
 * a missing ticket (`TicketNotFound`), disclosure-safe. New callers should
 * always pass it.
 */
export class TicketRepository extends Context.Tag("TicketRepository")<
  TicketRepository,
  {
    readonly create: (
      input: CreateTicketInput,
    ) => Effect.Effect<Ticket, TicketRepositoryError>;

    readonly getById: (
      id: TicketId,
      tenantId?: TenantId,
    ) => Effect.Effect<Ticket, TicketRepositoryError>;

    readonly findByThreadId: (
      tenantId: TenantId,
      threadId: ThreadId,
      /** When present, only a ticket stamped with this provider matches (D2). */
      provider?: ConversationProviderId,
      /** When present, only the ticket owned by this mailbox matches. */
      mailbox?: string,
    ) => Effect.Effect<Ticket | null, TicketRepositoryError>;

    /**
     * The conversation provider stamped on the ticket holding `threadId`, or
     * null when the ticket is missing or unstamped (legacy). Lets the
     * conversation router dispatch legacy (un-namespaced) thread ids by the
     * ticket's own stamp instead of guessing tenant-wide (audit D2).
     */
    readonly findThreadProvider: (
      tenantId: TenantId,
      threadId: ThreadId,
    ) => Effect.Effect<ConversationProviderId | null, TicketRepositoryError>;

    /**
     * Find the ticket that owns ANY of these RFC Message-IDs in the message-id
     * index. Used to correlate an inbound reply to its existing ticket when the
     * thread-id derived from its (reordered / truncated) `References` header
     * doesn't exact-match the ticket's stored `threadId` — the reply's
     * In-Reply-To / References point at a message we already recorded (a prior
     * inbound or our own outbound). Returns the most recently created match
     * when several ids resolve (they belong to the same thread in practice).
     */
    readonly findByMessageIds: (
      tenantId: TenantId,
      messageIds: ReadonlyArray<string>,
    ) => Effect.Effect<Ticket | null, TicketRepositoryError>;

    /**
     * Record an RFC Message-ID against a ticket in the message-id index, so a
     * later reply citing it resolves to this ticket. Idempotent — re-recording
     * the same id (redelivered poll / retried send) is a no-op. Recorded for
     * BOTH directions: inbound on accept, outbound on a successful send.
     */
    readonly recordMessageId: (input: {
      readonly tenantId: TenantId;
      readonly ticketId: TicketId;
      readonly messageId: string;
      readonly direction: "inbound" | "outbound";
    }) => Effect.Effect<void, TicketRepositoryError>;

    readonly update: (
      id: TicketId,
      patch: UpdatableTicketFields,
      tenantId?: TenantId,
    ) => Effect.Effect<Ticket, TicketRepositoryError>;

    readonly transitionStatus: (
      id: TicketId,
      toStatus: TicketStatus,
      opts?: TransitionStatusOptions,
    ) => Effect.Effect<Ticket, TicketRepositoryError>;
  }
>() {}

// ============================================================
// Test layer — in-memory
// ============================================================

const buildTicket = (input: CreateTicketInput, now: Date): Ticket => ({
  id: makeTicketId(randomUUID()),
  tenantId: input.tenantId,
  customerId: input.customerId ?? null,
  orderId: input.orderId ?? null,
  channel: input.channel,
  threadId: input.threadId ?? null,
  mailbox: input.mailbox ?? null,
  status: input.status ?? "new",
  currentAgentId: input.currentAgentId,
  priority: input.priority ?? "normal",
  summary: input.summary ?? null,
  subject: input.subject ?? null,
  context: input.context ?? {},
  epoch: 0,
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
  archivedAt: null,
});

export const TicketRepositoryTest = Layer.effect(
  TicketRepository,
  Effect.sync(() => {
    const store = new Map<string, Ticket>();
    // Provider stamp lives off to the side: the `Ticket` domain type doesn't
    // carry it (it's routing metadata, not agent-visible state).
    const providerOf = new Map<string, ConversationProviderId | null>();
    // Message-id index: `${tenantId}\0${messageId}` -> ticketId. Globally unique
    // per RFC, so within a tenant a message id maps to at most one ticket.
    const messageIndex = new Map<string, TicketId>();
    const indexKey = (tenantId: TenantId, messageId: string): string =>
      `${tenantId} ${messageId}`;

    // D9: enforce the optional tenant scope exactly like the Live impl — a
    // ticket under another tenant is indistinguishable from a missing one.
    const scoped = (id: TicketId, tenantId?: TenantId): Ticket | null => {
      const c = store.get(id);
      if (!c) return null;
      if (tenantId !== undefined && c.tenantId !== tenantId) return null;
      return c;
    };

    return TicketRepository.of({
      create: (input) =>
        Effect.sync(() => {
          const c = buildTicket(input, new Date());
          store.set(c.id, c);
          providerOf.set(c.id, resolveTicketProvider(input));
          return c;
        }),

      getById: (id, tenantId) =>
        Effect.suspend((): Effect.Effect<Ticket, TicketRepositoryError> => {
          const c = scoped(id, tenantId);
          return c
            ? Effect.succeed(c)
            : Effect.fail(new TicketNotFound({ ticketId: id }));
        }),

      findByThreadId: (tenantId, threadId, provider, mailbox) =>
        Effect.sync(() => {
          for (const c of store.values()) {
            if (c.tenantId !== tenantId || c.threadId !== threadId) continue;
            if (provider !== undefined && providerOf.get(c.id) !== provider) {
              continue;
            }
            if (mailbox !== undefined && c.mailbox !== mailbox) continue;
            return c;
          }
          return null;
        }),

      findThreadProvider: (tenantId, threadId) =>
        Effect.sync(() => {
          for (const c of store.values()) {
            if (c.tenantId === tenantId && c.threadId === threadId) {
              return providerOf.get(c.id) ?? null;
            }
          }
          return null;
        }),

      findByMessageIds: (tenantId, messageIds) =>
        Effect.sync(() => {
          const matches: Ticket[] = [];
          for (const messageId of messageIds) {
            const ticketId = messageIndex.get(indexKey(tenantId, messageId));
            if (!ticketId) continue;
            const c = store.get(ticketId);
            if (c && c.tenantId === tenantId) matches.push(c);
          }
          if (matches.length === 0) return null;
          // Most recently created wins when several ids resolve (mirrors the
          // Live impl's ORDER BY created_at DESC).
          return matches.reduce((a, b) =>
            b.createdAt.getTime() > a.createdAt.getTime() ? b : a,
          );
        }),

      recordMessageId: ({ tenantId, ticketId, messageId }) =>
        Effect.sync(() => {
          const key = indexKey(tenantId, messageId);
          // Idempotent: first writer wins, mirroring ON CONFLICT DO NOTHING.
          if (!messageIndex.has(key)) messageIndex.set(key, ticketId);
        }),

      update: (id, patch, tenantId) =>
        Effect.suspend((): Effect.Effect<Ticket, TicketRepositoryError> => {
          const existing = scoped(id, tenantId);
          if (!existing) return Effect.fail(new TicketNotFound({ ticketId: id }));
          const updated: Ticket = {
            ...existing,
            ...patch,
            updatedAt: new Date(),
          };
          store.set(id, updated);
          return Effect.succeed(updated);
        }),

      transitionStatus: (id, toStatus, opts = {}) =>
        Effect.suspend((): Effect.Effect<Ticket, TicketRepositoryError> => {
          const existing = scoped(id, opts.tenantId);
          if (!existing) return Effect.fail(new TicketNotFound({ ticketId: id }));
          if (
            opts.expectedFromStatus !== undefined &&
            existing.status !== opts.expectedFromStatus
          ) {
            return Effect.fail(
              new TicketStateConflict({
                ticketId: id,
                expected: opts.expectedFromStatus,
                actual: existing.status,
              }),
            );
          }
          // Master-plan §10 (audit L1): every status write obeys the
          // transition matrix — Test and Live enforce identically.
          if (!isStatusTransitionAllowed(existing.status, toStatus)) {
            return Effect.fail(
              new InvalidStatusTransition({
                ticketId: id,
                from: existing.status,
                to: toStatus,
              }),
            );
          }
          const now = new Date();
          const updated: Ticket = {
            ...existing,
            status: toStatus,
            updatedAt: now,
            resolvedAt: toStatus === "resolved" ? now : existing.resolvedAt,
            archivedAt:
              toStatus === "archived"
                ? now
                : existing.status === "archived"
                  ? null
                  : (existing.archivedAt ?? null),
          };
          store.set(id, updated);
          return Effect.succeed(updated);
        }),
    });
  }),
);
