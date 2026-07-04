import { Effect, FiberRef, Layer } from "effect";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  ApprovalNotFound,
  ApprovalService,
  ApprovalServiceDbError,
  ApprovalStateConflict,
  type ApproveInput,
  type CancelPendingForTicketInput,
  type CreateApprovalInput,
  type ApprovalServiceError,
  type RejectInput,
} from "@support-agent/services";
import {
  AgentId as makeAgentId,
  ApprovalId,
  TicketId as makeTicketId,
  TenantId as makeTenantId,
  UserId as makeUserId,
  type Approval,
  type ApprovalRiskLevel,
  type ApprovalStatus,
  type TicketId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));
import { approvals, tickets, type ApprovalRow } from "./schema.js";

const rowToApproval = (r: ApprovalRow): Approval => ({
  id: ApprovalId(r.id),
  tenantId: makeTenantId(r.tenantId),
  ticketId: makeTicketId(r.ticketId),
  agentId: makeAgentId(r.agentId),
  tool: r.tool,
  proposedInput: r.proposedInput as unknown,
  approvedInput: r.approvedInput as unknown,
  reasoning: r.reasoning ?? "",
  riskLevel: r.riskLevel as ApprovalRiskLevel,
  status: r.status as ApprovalStatus,
  decidedBy: r.decidedBy ? makeUserId(r.decidedBy) : null,
  decidedAt: r.decidedAt,
  decisionReason: r.decisionReason,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  epoch: r.epoch ?? 0,
  resumedAt: r.resumedAt ?? null,
});

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, ApprovalServiceDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ApprovalServiceDbError({ operation, cause }),
  });

export const ApprovalServiceLive = Layer.effect(
  ApprovalService,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const create = (
      input: CreateApprovalInput,
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const id = randomUUID();
        const inserted = yield* wrap(
          "create",
          db
            .insert(approvals)
            .values({
              id,
              tenantId: input.tenantId,
              ticketId: input.ticketId,
              agentId: input.agentId,
              tool: input.tool,
              proposedInput: input.proposedInput as object,
              reasoning: input.reasoning,
              riskLevel: input.riskLevel,
              status: "pending",
              expiresAt: input.expiresAt,
              epoch: input.epoch ?? 0,
            })
            .returning(),
        );
        const row = inserted[0];
        if (!row)
          return yield* Effect.fail(
            new ApprovalServiceDbError({
              operation: "create",
              cause: "insert returned no row",
            }),
          );
        return rowToApproval(row);
      });

    // D9: when a tenant scope is given, a cross-tenant approval behaves
    // exactly like a missing one.
    const idScope = (
      id: ReturnType<typeof ApprovalId>,
      tenantId?: TenantId,
    ) =>
      tenantId === undefined
        ? eq(approvals.id, id)
        : and(eq(approvals.id, id), eq(approvals.tenantId, tenantId));

    const getById = (
      id: ReturnType<typeof ApprovalId>,
      tenantId?: TenantId,
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "getById",
          db.select().from(approvals).where(idScope(id, tenantId)).limit(1),
        );
        const row = rows[0];
        if (!row)
          return yield* Effect.fail(new ApprovalNotFound({ approvalId: id }));
        return rowToApproval(row);
      });

    const transition = (
      id: ReturnType<typeof ApprovalId>,
      expected: ApprovalStatus,
      patch: {
        readonly status: ApprovalStatus;
        readonly decidedBy: string;
        readonly approvedInput?: unknown;
        readonly decisionReason?: string | null;
      },
      tenantId?: TenantId,
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const result = yield* wrap(
          "transition",
          db.transaction(async (tx) => {
            const currentRows = await tx
              .select()
              .from(approvals)
              .where(idScope(id, tenantId))
              .for("update")
              .limit(1);
            const current = currentRows[0];
            if (!current)
              return { kind: "not_found" as const, approvalId: id };
            if (current.status !== expected) {
              return {
                kind: "conflict" as const,
                approvalId: id,
                expected,
                actual: current.status as ApprovalStatus,
              };
            }
            const setPatch: Record<string, unknown> = {
              status: patch.status,
              decidedBy: patch.decidedBy,
              decidedAt: new Date(),
              decisionReason: patch.decisionReason ?? null,
            };
            if (patch.approvedInput !== undefined) {
              setPatch["approvedInput"] = patch.approvedInput;
            }
            const updated = await tx
              .update(approvals)
              .set(setPatch)
              .where(eq(approvals.id, id))
              .returning();
            return { kind: "ok" as const, row: updated[0]! };
          }),
        );

        switch (result.kind) {
          case "not_found":
            return yield* Effect.fail(
              new ApprovalNotFound({ approvalId: result.approvalId }),
            );
          case "conflict":
            return yield* Effect.fail(
              new ApprovalStateConflict({
                approvalId: result.approvalId,
                expected: result.expected,
                actual: result.actual,
              }),
            );
          case "ok":
            return rowToApproval(result.row);
        }
      });

    const approve = (input: ApproveInput) =>
      transition(
        input.id,
        "pending",
        {
          status: "approved",
          decidedBy: input.decidedBy,
          decisionReason: input.decisionReason ?? null,
          ...(input.approvedInput !== undefined
            ? { approvedInput: input.approvedInput }
            : {}),
        },
        input.tenantId,
      );

    const reject = (input: RejectInput) =>
      transition(
        input.id,
        "pending",
        {
          status: "rejected",
          decidedBy: input.decidedBy,
          decisionReason: input.decisionReason ?? null,
        },
        input.tenantId,
      );

    const markResumed = (
      id: ReturnType<typeof ApprovalId>,
      tenantId?: TenantId,
    ): Effect.Effect<void, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "markResumed",
          db
            .update(approvals)
            .set({ resumedAt: new Date() })
            .where(and(idScope(id, tenantId), isNull(approvals.resumedAt))),
        );
      });

    const cancelPendingForTicket = (
      input: CancelPendingForTicketInput,
    ): Effect.Effect<number, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "cancelPendingForTicket",
          db
            .update(approvals)
            .set({
              status: "rejected",
              decidedAt: new Date(),
              decidedBy: input.decidedBy,
              decisionReason: input.decisionReason,
            })
            .where(
              and(
                eq(approvals.tenantId, input.tenantId),
                eq(approvals.ticketId, input.ticketId),
                eq(approvals.status, "pending"),
              ),
            )
            .returning({ id: approvals.id }),
        );
        return rows.length;
      });

    const listPending = (
      tenantId: TenantId,
    ): Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listPending",
          db
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.tenantId, tenantId),
                eq(approvals.status, "pending"),
              ),
            )
            .orderBy(sql`${approvals.createdAt} ASC`),
        );
        return rows.map(rowToApproval);
      });

    const supersedePendingForTicket = (input: {
      readonly tenantId: TenantId;
      readonly ticketId: TicketId;
      readonly reason: string;
      readonly tools?: ReadonlyArray<string>;
    }): Effect.Effect<number, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "supersedePendingForTicket",
          db
            .update(approvals)
            .set({
              status: "cancelled",
              decidedAt: new Date(),
              decidedBy: null,
              decisionReason: input.reason,
            })
            .where(
              and(
                eq(approvals.tenantId, input.tenantId),
                eq(approvals.ticketId, input.ticketId),
                eq(approvals.status, "pending"),
                ...(input.tools && input.tools.length > 0
                  ? [inArray(approvals.tool, [...input.tools])]
                  : []),
              ),
            )
            .returning({ id: approvals.id }),
        );
        return rows.length;
      });

    const listForTicket = (
      tenantId: TenantId,
      ticketId: TicketId,
    ): Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listForTicket",
          db
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.tenantId, tenantId),
                eq(approvals.ticketId, ticketId),
              ),
            )
            .orderBy(sql`${approvals.createdAt} ASC`, sql`${approvals.id} ASC`),
        );
        return rows.map(rowToApproval);
      });

    // Audit L3b: decided rows whose ticket never resumed — the decision
    // committed but the workflow event was lost. Joined against tickets so
    // the sweep doesn't rescan history forever.
    const listDecidedUnresumed = (opts: {
      readonly decidedBefore: Date;
      readonly limit?: number;
    }): Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listDecidedUnresumed",
          db
            .select({ approval: approvals })
            .from(approvals)
            .innerJoin(tickets, eq(tickets.id, approvals.ticketId))
            .where(
              and(
                // APPROVED only: a rejection has nothing to re-run, and
                // republishing one would only re-force human_takeover (the
                // stale-reject-storm bug). Recovery hardening.
                eq(approvals.status, "approved"),
                // Not already acted on.
                isNull(approvals.resumedAt),
                // Only the ticket's CURRENT round — a decision from a prior
                // attempt (lower epoch) must never drive the new one.
                eq(approvals.epoch, tickets.epoch),
                // NB: `lt(col, date)` binds through the column's timestamp
                // encoder (Date -> ISO string). A raw `sql`${col} < ${date}``
                // would pass the Date straight to the driver, which throws
                // `TypeError: ... Received an instance of Date` and silently
                // killed this sweep in prod. Keep comparisons operator-based.
                lt(approvals.decidedAt, opts.decidedBefore),
                eq(tickets.status, "waiting_for_approval"),
              ),
            )
            .orderBy(sql`${approvals.decidedAt} ASC`)
            .limit(opts.limit ?? 100),
        );
        return rows.map((r) => rowToApproval(r.approval));
      });

    // Pending approvals due for a reminder re-notification (see the Tag doc).
    // All comparisons are operator-based (`lt`/`gte`/`isNull`) so the Date
    // binds through the column's timestamp encoder — a raw `sql` fragment with
    // a JS Date throws in the pg driver (the bug that silently killed the old
    // expiry sweep). Keep it operator-based.
    const listPendingNeedingReminder = (opts: {
      readonly createdBefore: Date;
      readonly createdAfter: Date;
      readonly remindedBefore: Date;
      readonly limit?: number;
    }): Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "listPendingNeedingReminder",
          db
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.status, "pending"),
                lt(approvals.createdAt, opts.createdBefore),
                gte(approvals.createdAt, opts.createdAfter),
                or(
                  isNull(approvals.lastRemindedAt),
                  lt(approvals.lastRemindedAt, opts.remindedBefore),
                ),
              ),
            )
            .orderBy(sql`${approvals.createdAt} ASC`)
            .limit(opts.limit ?? 100),
        );
        return rows.map(rowToApproval);
      });

    const recordReminderSent = (
      id: ReturnType<typeof ApprovalId>,
      at: Date,
    ): Effect.Effect<void, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "recordReminderSent",
          db
            .update(approvals)
            .set({ lastRemindedAt: at })
            .where(eq(approvals.id, id)),
        );
      });

    return ApprovalService.of({
      create,
      getById,
      approve,
      reject,
      markResumed,
      listPending,
      listForTicket,
      cancelPendingForTicket,
      supersedePendingForTicket,
      listDecidedUnresumed,
      listPendingNeedingReminder,
      recordReminderSent,
    });
  }),
);
