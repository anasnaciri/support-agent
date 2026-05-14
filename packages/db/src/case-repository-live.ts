import { Effect, Layer } from "effect";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  CaseNotFound,
  CaseRepository,
  CaseRepositoryDbError,
  CaseStateConflict,
  type CaseRepositoryError,
  type CreateCaseInput,
  type TransitionStatusOptions,
  type UpdatableCaseFields,
} from "@support-agent/services";
import {
  CaseId,
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
import { DbClient } from "./db-client.js";
import {
  cases,
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
  category: r.category,
  status: r.status as CaseStatus,
  currentAgentId: makeAgentId(r.currentAgentId),
  priority: r.priority as CasePriority,
  summary: r.summary,
  subject: r.subject,
  context: r.context as CaseContext,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  resolvedAt: r.resolvedAt,
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
    const db = yield* DbClient;

    const create = (
      input: CreateCaseInput,
    ): Effect.Effect<Case, CaseRepositoryError> =>
      Effect.gen(function* () {
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

    const getById = (id: CaseId): Effect.Effect<Case, CaseRepositoryError> =>
      Effect.gen(function* () {
        const rows = yield* wrap(
          "getById",
          db.select().from(cases).where(eq(cases.id, id)).limit(1),
        );
        const row = rows[0];
        if (!row) return yield* Effect.fail(new CaseNotFound({ caseId: id }));
        return rowToCase(row);
      });

    const findByThreadId = (
      tenantId: TenantId,
      threadId: ThreadId,
    ): Effect.Effect<Case | null, CaseRepositoryError> =>
      Effect.gen(function* () {
        const rows = yield* wrap(
          "findByThreadId",
          db
            .select()
            .from(cases)
            .where(and(eq(cases.tenantId, tenantId), eq(cases.threadId, threadId)))
            .limit(1),
        );
        const row = rows[0];
        return row ? rowToCase(row) : null;
      });

    const update = (
      id: CaseId,
      patch: UpdatableCaseFields,
    ): Effect.Effect<Case, CaseRepositoryError> =>
      Effect.gen(function* () {
        const dbPatch: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.customerId !== undefined) dbPatch["customerId"] = patch.customerId;
        if (patch.orderId !== undefined) dbPatch["shopifyOrderId"] = patch.orderId;
        if (patch.threadId !== undefined) dbPatch["threadId"] = patch.threadId;
        if (patch.category !== undefined) dbPatch["category"] = patch.category;
        if (patch.currentAgentId !== undefined)
          dbPatch["currentAgentId"] = patch.currentAgentId;
        if (patch.priority !== undefined) dbPatch["priority"] = patch.priority;
        if (patch.subject !== undefined) dbPatch["subject"] = patch.subject;
        if (patch.summary !== undefined) dbPatch["summary"] = patch.summary;
        if (patch.context !== undefined) dbPatch["context"] = patch.context;

        const updated = yield* wrap(
          "update",
          db.update(cases).set(dbPatch).where(eq(cases.id, id)).returning(),
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
        // Both writes in one tx (master-plan §10 state-machine invariant)
        const result = yield* wrap(
          "transitionStatus",
          db.transaction(async (tx) => {
            const currentRows = await tx
              .select()
              .from(cases)
              .where(eq(cases.id, id))
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
            const now = new Date();
            const updated = await tx
              .update(cases)
              .set({
                status: toStatus,
                updatedAt: now,
                resolvedAt:
                  toStatus === "resolved" ? now : current.resolvedAt,
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
          case "ok":
            return rowToCase(result.row);
        }
      });

    return CaseRepository.of({
      create,
      getById,
      findByThreadId,
      update,
      transitionStatus,
    });
  }),
);
