import { Effect, FiberRef, Layer } from "effect";
import { and, eq, sql } from "drizzle-orm";
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
import { approvals, type ApprovalRow } from "./schema.js";

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

    const getById = (
      id: ReturnType<typeof ApprovalId>,
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "getById",
          db.select().from(approvals).where(eq(approvals.id, id)).limit(1),
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
    ): Effect.Effect<Approval, ApprovalServiceError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const result = yield* wrap(
          "transition",
          db.transaction(async (tx) => {
            const currentRows = await tx
              .select()
              .from(approvals)
              .where(eq(approvals.id, id))
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
      transition(input.id, "pending", {
        status: "approved",
        decidedBy: input.decidedBy,
        decisionReason: input.decisionReason ?? null,
        ...(input.approvedInput !== undefined
          ? { approvedInput: input.approvedInput }
          : {}),
      });

    const reject = (input: RejectInput) =>
      transition(input.id, "pending", {
        status: "rejected",
        decidedBy: input.decidedBy,
        decisionReason: input.decisionReason ?? null,
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

    return ApprovalService.of({
      create,
      getById,
      approve,
      reject,
      listPending,
    });
  }),
);
