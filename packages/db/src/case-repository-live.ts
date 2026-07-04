import { Effect, FiberRef, Layer } from "effect";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  CaseNotFound,
  CaseRepository,
  CaseRepositoryDbError,
  CaseStateConflict,
  InvalidStatusTransition,
  isConversationProvider,
  resolveCaseProvider,
  type CaseRepositoryError,
  type ConversationProviderId,
  type CreateCaseInput,
  type TransitionStatusOptions,
  type UpdatableCaseFields,
} from "@support-agent/services";
import {
  CaseId,
  isStatusTransitionAllowed,
  type Case,
  type CaseChannel,
  type CaseContext,
  type CasePriority,
  type CaseStatus,
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
  cases,
  caseMessageIds,
  caseStateTransitions,
  type CaseRow,
} from "./schema.js";

const rowToCase = (r: CaseRow): Case => ({
  id: CaseId(r.id),
  tenantId: makeTenantId(r.tenantId),
  customerId: r.customerId ? makeCustomerId(r.customerId) : null,
  orderId: r.shopifyOrderId ? makeOrderId(r.shopifyOrderId) : null,
  channel: r.channel as CaseChannel,
  threadId: r.threadId ? makeThreadId(r.threadId) : null,
  mailbox: r.mailbox,
  category: r.category,
  status: r.status as CaseStatus,
  currentAgentId: makeAgentId(r.currentAgentId),
  priority: r.priority as CasePriority,
  summary: r.summary,
  subject: r.subject,
  context: r.context as CaseContext,
  epoch: r.epoch ?? 0,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  resolvedAt: r.resolvedAt,
  archivedAt: r.archivedAt,
});

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, CaseRepositoryDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new CaseRepositoryDbError({ operation, cause }),
  });

export const CaseRepositoryLive = Layer.effect(
  CaseRepository,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const create = (
      input: CreateCaseInput,
    ): Effect.Effect<Case, CaseRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const id = randomUUID();
        const inserted = yield* wrap(
          "create",
          db
            .insert(cases)
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
              provider: resolveCaseProvider(input),
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
            new CaseRepositoryDbError({
              operation: "create",
              cause: "insert returned no row",
            }),
          );
        }
        return rowToCase(row);
      });

    // D9: a tenant-scoped `WHERE` — when no tenantId is given this stays the
    // bare-id lookup, when given a cross-tenant id behaves like a miss.
    const idScope = (id: CaseId, tenantId?: TenantId) =>
      tenantId === undefined
        ? eq(cases.id, id)
        : and(eq(cases.id, id), eq(cases.tenantId, tenantId));

    const getById = (
      id: CaseId,
      tenantId?: TenantId,
    ): Effect.Effect<Case, CaseRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "getById",
          db.select().from(cases).where(idScope(id, tenantId)).limit(1),
        );
        const row = rows[0];
        if (!row) return yield* Effect.fail(new CaseNotFound({ caseId: id }));
        return rowToCase(row);
      });

    const findByThreadId = (
      tenantId: TenantId,
      threadId: ThreadId,
      provider?: ConversationProviderId,
      mailbox?: string,
    ): Effect.Effect<Case | null, CaseRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findByThreadId",
          db
            .select()
            .from(cases)
            .where(
              and(
                eq(cases.tenantId, tenantId),
                eq(cases.threadId, threadId),
                // D2: include the provider in the lookup key when known, so
                // a (theoretical) cross-provider threadId collision can't
                // resolve to the wrong case.
                ...(provider !== undefined
                  ? [eq(cases.provider, provider)]
                  : []),
                ...(mailbox !== undefined ? [eq(cases.mailbox, mailbox)] : []),
              ),
            )
            .limit(1),
        );
        const row = rows[0];
        return row ? rowToCase(row) : null;
      });

    const findThreadProvider = (
      tenantId: TenantId,
      threadId: ThreadId,
    ): Effect.Effect<ConversationProviderId | null, CaseRepositoryError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findThreadProvider",
          db
            .select({ provider: cases.provider })
            .from(cases)
            .where(
              and(eq(cases.tenantId, tenantId), eq(cases.threadId, threadId)),
            )
            .limit(1),
        );
        const provider = rows[0]?.provider;
        return provider && isConversationProvider(provider) ? provider : null;
      });

    const findByMessageIds = (
      tenantId: TenantId,
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<Case | null, CaseRepositoryError> =>
      Effect.gen(function* () {
        const ids = [...new Set(messageIds.filter((m) => m.length > 0))];
        if (ids.length === 0) return null;
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "findByMessageIds",
          db
            .select({ case: cases })
            .from(caseMessageIds)
            .innerJoin(cases, eq(caseMessageIds.caseId, cases.id))
            .where(
              and(
                eq(caseMessageIds.tenantId, tenantId),
                inArray(caseMessageIds.messageId, ids),
              ),
            )
            // Several ids resolving to different cases is pathological (they
            // belong to one thread); pick the most recent deterministically.
            .orderBy(desc(cases.createdAt))
            .limit(1),
        );
        const row = rows[0]?.case;
        return row ? rowToCase(row) : null;
      });

    const recordMessageId = (input: {
      readonly tenantId: TenantId;
      readonly caseId: CaseId;
      readonly messageId: string;
      readonly direction: "inbound" | "outbound";
    }): Effect.Effect<void, CaseRepositoryError> =>
      Effect.gen(function* () {
        if (input.messageId.length === 0) return;
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "recordMessageId",
          db
            .insert(caseMessageIds)
            .values({
              tenantId: input.tenantId,
              caseId: input.caseId,
              messageId: input.messageId,
              direction: input.direction,
            })
            // Idempotent: a redelivered poll / retried send re-records the
            // same id; the first writer (whichever case) keeps the mapping.
            .onConflictDoNothing({
              target: [caseMessageIds.tenantId, caseMessageIds.messageId],
            }),
        );
      });

    const update = (
      id: CaseId,
      patch: UpdatableCaseFields,
      tenantId?: TenantId,
    ): Effect.Effect<Case, CaseRepositoryError> =>
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
            .update(cases)
            .set(dbPatch)
            .where(idScope(id, tenantId))
            .returning(),
        );
        const row = updated[0];
        if (!row) return yield* Effect.fail(new CaseNotFound({ caseId: id }));
        return rowToCase(row);
      });

    const transitionStatus = (
      id: CaseId,
      toStatus: CaseStatus,
      opts: TransitionStatusOptions = {},
    ): Effect.Effect<Case, CaseRepositoryError> =>
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
              .from(cases)
              .where(idScope(id, opts.tenantId))
              .for("update")
              .limit(1);
            const current = currentRows[0];
            if (!current)
              return { kind: "not_found" as const, caseId: id };
            if (
              opts.expectedFromStatus !== undefined &&
              current.status !== opts.expectedFromStatus
            ) {
              return {
                kind: "conflict" as const,
                caseId: id,
                expected: opts.expectedFromStatus,
                actual: current.status as CaseStatus,
              };
            }
            // Master-plan §10 (audit L1): the transition matrix guards
            // every status write, under the same row lock as the write.
            if (
              !isStatusTransitionAllowed(
                current.status as CaseStatus,
                toStatus,
              )
            ) {
              return {
                kind: "invalid_transition" as const,
                caseId: id,
                from: current.status as CaseStatus,
                to: toStatus,
              };
            }
            const now = new Date();
            const updated = await tx
              .update(cases)
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
              .where(eq(cases.id, id))
              .returning();
            await tx.insert(caseStateTransitions).values({
              caseId: id,
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
            return yield* Effect.fail(new CaseNotFound({ caseId: result.caseId }));
          case "conflict":
            return yield* Effect.fail(
              new CaseStateConflict({
                caseId: result.caseId,
                expected: result.expected,
                actual: result.actual,
              }),
            );
          case "invalid_transition":
            return yield* Effect.fail(
              new InvalidStatusTransition({
                caseId: result.caseId,
                from: result.from,
                to: result.to,
              }),
            );
          case "ok":
            return rowToCase(result.row);
        }
      });

    return CaseRepository.of({
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
