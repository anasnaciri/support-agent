import { Effect, FiberRef, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import {
  IdempotencyStoreDbError,
  ProcessedMessageStore,
  ToolExecutionStore,
  type ClaimMessageInput,
  type ClaimMessageResult,
  type RecordExecutionInput,
  type ToolExecutionMarker,
} from "@support-agent/services";
import { CaseId as makeCaseId } from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { processedMessages, toolExecutions } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  operation: string,
  promise: Promise<A>,
): Effect.Effect<A, IdempotencyStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new IdempotencyStoreDbError({ operation, cause }),
  });

export const ProcessedMessageStoreLive = Layer.effect(
  ProcessedMessageStore,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const seen = (
      input: ClaimMessageInput,
    ): Effect.Effect<boolean, IdempotencyStoreDbError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "seen",
          db
            .select({ id: processedMessages.id })
            .from(processedMessages)
            .where(
              and(
                eq(processedMessages.tenantId, input.tenantId),
                eq(processedMessages.provider, input.provider),
                eq(processedMessages.messageId, input.messageId),
              ),
            )
            .limit(1),
        );
        return rows.length > 0;
      });

    const claim = (
      input: ClaimMessageInput,
    ): Effect.Effect<ClaimMessageResult, IdempotencyStoreDbError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        // ON CONFLICT DO NOTHING + returning(): exactly one claimer ever
        // gets a row back for a given (tenant, provider, messageId).
        const inserted = yield* wrap(
          "claim",
          db
            .insert(processedMessages)
            .values({
              tenantId: input.tenantId,
              provider: input.provider,
              messageId: input.messageId,
              threadId: input.threadId ?? null,
              caseId: input.caseId ?? null,
            })
            .onConflictDoNothing()
            .returning({ id: processedMessages.id }),
        );
        return inserted.length > 0 ? "new" : "duplicate";
      });

    return ProcessedMessageStore.of({ seen, claim });
  }),
);

export const ToolExecutionStoreLive = Layer.effect(
  ToolExecutionStore,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    const record = (
      input: RecordExecutionInput,
    ): Effect.Effect<void, IdempotencyStoreDbError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        yield* wrap(
          "record",
          db
            .insert(toolExecutions)
            .values({
              tenantId: input.tenantId,
              caseId: input.caseId,
              callId: input.callId,
              tool: input.tool,
              resultOk: input.resultOk,
            })
            .onConflictDoNothing(),
        );
      });

    const find = (
      caseId: ToolExecutionMarker["caseId"],
      callId: string,
    ): Effect.Effect<ToolExecutionMarker | null, IdempotencyStoreDbError> =>
      Effect.gen(function* () {
        const db = yield* useDb(defaultDb);
        const rows = yield* wrap(
          "find",
          db
            .select()
            .from(toolExecutions)
            .where(
              and(
                eq(toolExecutions.caseId, caseId),
                eq(toolExecutions.callId, callId),
              ),
            )
            .limit(1),
        );
        const row = rows[0];
        if (!row) return null;
        return {
          caseId: makeCaseId(row.caseId),
          callId: row.callId,
          tool: row.tool,
          resultOk: row.resultOk,
          executedAt: row.executedAt,
        };
      });

    return ToolExecutionStore.of({ record, find });
  }),
);
