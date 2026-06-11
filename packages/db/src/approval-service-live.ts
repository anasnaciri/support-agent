import { Effect, FiberRef, Layer } from "effect";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  ApprovalNotFound,
  ApprovalService,
  ApprovalServiceDbError,
  ApprovalStateConflict,
  type ApproveInput,
  type CreateApprovalInput,
  type ApprovalServiceError,
  type RejectInput,
} from "@support-agent/services";
import {
  AgentId as makeAgentId,
  ApprovalId,
  CaseId as makeCaseId,
  TenantId as makeTenantId,
  UserId as makeUserId,
  type Approval,
  type ApprovalRiskLevel,
  type ApprovalStatus,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));
import { approvals, cases, type ApprovalRow } from "./schema.js";

const rowToApproval = (r: ApprovalRow): Approval => ({
  id: ApprovalId(r.id),
  tenantId: makeTenantId(r.tenantId),
  caseId: makeCaseId(r.caseId),
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
              caseId: input.caseId,
              agentId: input.agentId,
              tool: input.tool,
              proposedInput: input.proposedInput as object,
              reasoning: input.reasoning,
              riskLevel: input.riskLevel,
              status: "pending",
              expiresAt: input.expiresAt,
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

    // Audit L7: expire overdue pendings (CAS on status='pending' inside
    // the UPDATE, so racing deciders win cleanly).
    const expireOverdue = (
      now: Date,
      limit = 100,
    ): Effect.Effect<ReadonlyArray<Approval>, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "expireOverdue",
          db
            .update(approvals)
            .set({ status: "expired" })
            .where(
              and(
                eq(approvals.status, "pending"),
                sql`${approvals.expiresAt} < ${now}`,
                sql`${approvals.id} IN (
                  SELECT id FROM ${approvals}
                  WHERE ${approvals.status} = 'pending'
                    AND ${approvals.expiresAt} < ${now}
                  ORDER BY ${approvals.expiresAt} ASC
                  LIMIT ${limit}
                )`,
              ),
            )
            .returning(),
        );
        return rows.map(rowToApproval);
      });

    // Audit L3b: decided rows whose case never resumed — the decision
    // committed but the workflow event was lost. Joined against cases so
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
            .innerJoin(cases, eq(cases.id, approvals.caseId))
            .where(
              and(
                inArray(approvals.status, ["approved", "rejected"]),
                sql`${approvals.decidedAt} < ${opts.decidedBefore}`,
                eq(cases.status, "waiting_for_approval"),
              ),
            )
            .orderBy(sql`${approvals.decidedAt} ASC`)
            .limit(opts.limit ?? 100),
        );
        return rows.map((r) => rowToApproval(r.approval));
      });

    return ApprovalService.of({
      create,
      getById,
      approve,
      reject,
      listPending,
      expireOverdue,
      listDecidedUnresumed,
    });
  }),
);
