import { Effect, FiberRef, Layer } from "effect";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  TicketNotFound,
  TicketRepository,
  TicketRepositoryDbError,
  TicketStateConflict,
  InvalidStatusTransition,
  isConversationProvider,
  resolveTicketProvider,
  type TicketRepositoryError,
  type ConversationProviderId,
  type CreateTicketInput,
  type TransitionStatusOptions,
  type UpdatableTicketFields,
} from "@support-agent/services";
import {
  TicketId,
  isStatusTransitionAllowed,
  type Ticket,
  type TicketChannel,
  type TicketContext,
  type TicketPriority,
  type TicketStatus,
  type CustomerId,
  type OrderId,
  type TenantId,
  type ThreadId,
  type AgentId,
  TenantId as makeTenantId,
  AgentId as makeAgentId,
  CustomerId as makeCustomerId,
  OrderId as makeOrderId,
  ThreadId as makeThreadId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));
import {
  tickets,
  ticketMessageIds,
  ticketStateTransitions,
  type TicketRow,
} from "./schema.js";

const rowToTicket = (r: TicketRow): Ticket => ({
  id: TicketId(r.id),
  tenantId: makeTenantId(r.tenantId),
  customerId: r.customerId ? makeCustomerId(r.customerId) : null,
  orderId: r.shopifyOrderId ? makeOrderId(r.shopifyOrderId) : null,
  channel: r.channel as TicketChannel,
  threadId: r.threadId ? makeThreadId(r.threadId) : null,
  mailbox: r.mailbox,
  category: r.category,
  status: r.status as TicketStatus,
  currentAgentId: makeAgentId(r.currentAgentId),
  priority: r.priority as TicketPriority,
  summary: r.summary,
  subject: r.subject,
  context: r.context as TicketContext,
  epoch: r.epoch ?? 0,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  resolvedAt: r.resolvedAt,
  archivedAt: r.archivedAt,
});

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, TicketRepositoryDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new TicketRepositoryDbError({ operation, cause }),
  });

export const TicketRepositoryLive = Layer.effect(
  TicketRepository,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const create = (
      input: CreateTicketInput,
    ): Effect.Effect<Ticket, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const id = randomUUID();
        const inserted = yield* wrap(
          "create",
          db
            .insert(tickets)
            .values({
              id,
              tenantId: input.tenantId,
              customerId: input.customerId ?? null,
              shopifyOrderId: input.orderId ?? null,
              channel: input.channel,
              threadId: input.threadId ?? null,
              mailbox: input.mailbox ?? null,
              // D2: stamp the owning conversation connector — explicit input
              // first, else derived from a namespaced threadId.
              provider: resolveTicketProvider(input),
              category: input.category ?? null,
              status: input.status ?? "new",
              currentAgentId: input.currentAgentId,
              priority: input.priority ?? "normal",
              subject: input.subject ?? null,
              summary: input.summary ?? null,
              context: input.context ?? {},
            })
            .returning(),
        );
        const row = inserted[0];
        if (!row) {
          return yield* Effect.fail(
            new TicketRepositoryDbError({
              operation: "create",
              cause: "insert returned no row",
            }),
          );
        }
        return rowToTicket(row);
      });

    // D9: a tenant-scoped `WHERE` — when no tenantId is given this stays the
    // bare-id lookup, when given a cross-tenant id behaves like a miss.
    const idScope = (id: TicketId, tenantId?: TenantId) =>
      tenantId === undefined
        ? eq(tickets.id, id)
        : and(eq(tickets.id, id), eq(tickets.tenantId, tenantId));

    const getById = (
      id: TicketId,
      tenantId?: TenantId,
    ): Effect.Effect<Ticket, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "getById",
          db.select().from(tickets).where(idScope(id, tenantId)).limit(1),
        );
        const row = rows[0];
        if (!row) return yield* Effect.fail(new TicketNotFound({ ticketId: id }));
        return rowToTicket(row);
      });

    const findByThreadId = (
      tenantId: TenantId,
      threadId: ThreadId,
      provider?: ConversationProviderId,
      mailbox?: string,
    ): Effect.Effect<Ticket | null, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findByThreadId",
          db
            .select()
            .from(tickets)
            .where(
              and(
                eq(tickets.tenantId, tenantId),
                eq(tickets.threadId, threadId),
                // D2: include the provider in the lookup key when known, so
                // a (theoretical) cross-provider threadId collision can't
                // resolve to the wrong ticket.
                ...(provider !== undefined
                  ? [eq(tickets.provider, provider)]
                  : []),
                ...(mailbox !== undefined ? [eq(tickets.mailbox, mailbox)] : []),
              ),
            )
            .limit(1),
        );
        const row = rows[0];
        return row ? rowToTicket(row) : null;
      });

    const findThreadProvider = (
      tenantId: TenantId,
      threadId: ThreadId,
    ): Effect.Effect<ConversationProviderId | null, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findThreadProvider",
          db
            .select({ provider: tickets.provider })
            .from(tickets)
            .where(
              and(eq(tickets.tenantId, tenantId), eq(tickets.threadId, threadId)),
            )
            .limit(1),
        );
        const provider = rows[0]?.provider;
        return provider && isConversationProvider(provider) ? provider : null;
      });

    const findByMessageIds = (
      tenantId: TenantId,
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<Ticket | null, TicketRepositoryError> =>
      Effect.gen(function* () {
        const ids = [...new Set(messageIds.filter((m) => m.length > 0))];
        if (ids.length === 0) return null;
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findByMessageIds",
          db
            .select({ ticket: tickets })
            .from(ticketMessageIds)
            .innerJoin(tickets, eq(ticketMessageIds.ticketId, tickets.id))
            .where(
              and(
                eq(ticketMessageIds.tenantId, tenantId),
                inArray(ticketMessageIds.messageId, ids),
              ),
            )
            // Several ids resolving to different tickets is pathological (they
            // belong to one thread); pick the most recent deterministically.
            .orderBy(desc(tickets.createdAt))
            .limit(1),
        );
        const row = rows[0]?.ticket;
        return row ? rowToTicket(row) : null;
      });

    const recordMessageId = (input: {
      readonly tenantId: TenantId;
      readonly ticketId: TicketId;
      readonly messageId: string;
      readonly direction: "inbound" | "outbound";
    }): Effect.Effect<void, TicketRepositoryError> =>
      Effect.gen(function* () {
        if (input.messageId.length === 0) return;
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "recordMessageId",
          db
            .insert(ticketMessageIds)
            .values({
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              messageId: input.messageId,
              direction: input.direction,
            })
            // Idempotent: a redelivered poll / retried send re-records the
            // same id; the first writer (whichever ticket) keeps the mapping.
            .onConflictDoNothing({
              target: [ticketMessageIds.tenantId, ticketMessageIds.messageId],
            }),
        );
      });

    const update = (
      id: TicketId,
      patch: UpdatableTicketFields,
      tenantId?: TenantId,
    ): Effect.Effect<Ticket, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const dbPatch: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.customerId !== undefined) dbPatch["customerId"] = patch.customerId;
        if (patch.orderId !== undefined) dbPatch["shopifyOrderId"] = patch.orderId;
        if (patch.threadId !== undefined) dbPatch["threadId"] = patch.threadId;
        if (patch.mailbox !== undefined) dbPatch["mailbox"] = patch.mailbox;
        if (patch.category !== undefined) dbPatch["category"] = patch.category;
        if (patch.currentAgentId !== undefined)
          dbPatch["currentAgentId"] = patch.currentAgentId;
        if (patch.priority !== undefined) dbPatch["priority"] = patch.priority;
        if (patch.subject !== undefined) dbPatch["subject"] = patch.subject;
        if (patch.summary !== undefined) dbPatch["summary"] = patch.summary;
        if (patch.context !== undefined) dbPatch["context"] = patch.context;
        if (patch.epoch !== undefined) dbPatch["epoch"] = patch.epoch;

        const updated = yield* wrap(
          "update",
          db
            .update(tickets)
            .set(dbPatch)
            .where(idScope(id, tenantId))
            .returning(),
        );
        const row = updated[0];
        if (!row) return yield* Effect.fail(new TicketNotFound({ ticketId: id }));
        return rowToTicket(row);
      });

    const transitionStatus = (
      id: TicketId,
      toStatus: TicketStatus,
      opts: TransitionStatusOptions = {},
    ): Effect.Effect<Ticket, TicketRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        // Both writes in one tx (master-plan §10 state-machine invariant).
        // If a withTransaction(...) is active, `db` is already a Drizzle tx;
        // `db.transaction(...)` on a tx opens a SAVEPOINT — same atomic
        // guarantee, nested in the outer tx.
        const result = yield* wrap(
          "transitionStatus",
          db.transaction(async (tx) => {
            const currentRows = await tx
              .select()
              .from(tickets)
              .where(idScope(id, opts.tenantId))
              .for("update")
              .limit(1);
            const current = currentRows[0];
            if (!current)
              return { kind: "not_found" as const, ticketId: id };
            if (
              opts.expectedFromStatus !== undefined &&
              current.status !== opts.expectedFromStatus
            ) {
              return {
                kind: "conflict" as const,
                ticketId: id,
                expected: opts.expectedFromStatus,
                actual: current.status as TicketStatus,
              };
            }
            // Master-plan §10 (audit L1): the transition matrix guards
            // every status write, under the same row lock as the write.
            if (
              !isStatusTransitionAllowed(
                current.status as TicketStatus,
                toStatus,
              )
            ) {
              return {
                kind: "invalid_transition" as const,
                ticketId: id,
                from: current.status as TicketStatus,
                to: toStatus,
              };
            }
            const now = new Date();
            const updated = await tx
              .update(tickets)
              .set({
                status: toStatus,
                updatedAt: now,
                resolvedAt:
                  toStatus === "resolved" ? now : current.resolvedAt,
                archivedAt:
                  toStatus === "archived"
                    ? now
                    : current.status === "archived"
                      ? null
                      : current.archivedAt,
              })
              .where(eq(tickets.id, id))
              .returning();
            await tx.insert(ticketStateTransitions).values({
              ticketId: id,
              fromStatus: current.status,
              toStatus,
              eventId: opts.eventId ?? null,
              reason: opts.reason ?? null,
            });
            return { kind: "ok" as const, row: updated[0]! };
          }),
        );

        switch (result.kind) {
          case "not_found":
            return yield* Effect.fail(new TicketNotFound({ ticketId: result.ticketId }));
          case "conflict":
            return yield* Effect.fail(
              new TicketStateConflict({
                ticketId: result.ticketId,
                expected: result.expected,
                actual: result.actual,
              }),
            );
          case "invalid_transition":
            return yield* Effect.fail(
              new InvalidStatusTransition({
                ticketId: result.ticketId,
                from: result.from,
                to: result.to,
              }),
            );
          case "ok":
            return rowToTicket(result.row);
        }
      });

    return TicketRepository.of({
      create,
      getById,
      findByThreadId,
      findThreadProvider,
      findByMessageIds,
      recordMessageId,
      update,
      transitionStatus,
    });
  }),
);
