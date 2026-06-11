import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Idempotency stores (audit C2 / C3)
// ============================================================
//
// pg-boss and the inbound webhooks are at-least-once. Two stores make
// redelivery safe:
//
//   - ProcessedMessageStore (C3): one row per (tenant, provider,
//     messageId). The runtime claims the key at the top of a
//     `message.received` tick; a duplicate Pub/Sub push — or the Gmail
//     cursor-expiry reseed replaying up to 50 historical messages —
//     resolves to "duplicate" and the tick short-circuits instead of
//     running a second full agent loop (second LLM spend, second reply).
//
//   - ToolExecutionStore (C2): one row per (case, execution key). A
//     side-effecting tool records the marker in the SAME transaction as
//     its `tool.invoked` audit row; a re-delivered job (approval resume
//     re-run after a crash, retry past expireInSeconds) consults the
//     marker first and skips the side effect instead of double-issuing
//     a refund or double-sending an email. The execution key is the
//     tool's input-derived idempotency key when it declares one
//     (refund: orderId+amount+currency; reply: draftId) so even a fresh
//     LLM re-emission of the same action dedupes; otherwise the callId.

export class IdempotencyStoreDbError extends Data.TaggedError(
  "IdempotencyStoreDbError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

// ============================================================
// ProcessedMessageStore (C3)
// ============================================================

export interface ClaimMessageInput {
  readonly tenantId: TenantId;
  readonly provider: string;
  readonly messageId: string;
  readonly threadId?: string | null;
  readonly caseId?: CaseId | null;
}

export type ClaimMessageResult = "new" | "duplicate";

export class ProcessedMessageStore extends Context.Tag(
  "ProcessedMessageStore",
)<
  ProcessedMessageStore,
  {
    /**
     * Has this message key already been claimed? Checked at the TOP of a
     * tick. Deliberately a separate read from `claim`: the claim is only
     * written after the tick completes, so a retryable failure leaves the
     * key unclaimed and pg-boss's retry reprocesses the event (claiming
     * up-front would convert every transient failure into a silently
     * dropped message — the exact C1 bug).
     */
    readonly seen: (
      input: ClaimMessageInput,
    ) => Effect.Effect<boolean, IdempotencyStoreDbError>;

    /**
     * Atomically claim a message key. Returns "new" exactly once per
     * (tenant, provider, messageId) — every later claim returns
     * "duplicate" (INSERT … ON CONFLICT DO NOTHING under the hood).
     */
    readonly claim: (
      input: ClaimMessageInput,
    ) => Effect.Effect<ClaimMessageResult, IdempotencyStoreDbError>;
  }
>() {}

export const ProcessedMessageStoreTest = Layer.sync(
  ProcessedMessageStore,
  () => {
    const seenKeys = new Set<string>();
    const keyOf = (input: ClaimMessageInput) =>
      `${input.tenantId}:${input.provider}:${input.messageId}`;
    return ProcessedMessageStore.of({
      seen: (input) => Effect.sync(() => seenKeys.has(keyOf(input))),
      claim: (input) =>
        Effect.sync(() => {
          const key = keyOf(input);
          if (seenKeys.has(key)) return "duplicate";
          seenKeys.add(key);
          return "new";
        }),
    });
  },
);

// ============================================================
// ToolExecutionStore (C2)
// ============================================================

export interface RecordExecutionInput {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  /** Stable execution key: tool idempotency key or the LLM callId. */
  readonly callId: string;
  readonly tool: string;
  readonly resultOk: boolean;
}

export interface ToolExecutionMarker {
  readonly caseId: CaseId;
  readonly callId: string;
  readonly tool: string;
  readonly resultOk: boolean | null;
  readonly executedAt: Date;
}

export class ToolExecutionStore extends Context.Tag("ToolExecutionStore")<
  ToolExecutionStore,
  {
    /**
     * Record an execution marker. Call inside the same transaction as
     * the tool's audit write so the marker and the audit row commit (or
     * roll back) together. Conflicts on (caseId, callId) are upserts —
     * the first writer wins and later writes are no-ops.
     */
    readonly record: (
      input: RecordExecutionInput,
    ) => Effect.Effect<void, IdempotencyStoreDbError>;

    readonly find: (
      caseId: CaseId,
      callId: string,
    ) => Effect.Effect<ToolExecutionMarker | null, IdempotencyStoreDbError>;
  }
>() {}

export const ToolExecutionStoreTest = Layer.sync(ToolExecutionStore, () => {
  const rows = new Map<string, ToolExecutionMarker>();
  const key = (caseId: string, callId: string) => `${caseId}:${callId}`;
  return ToolExecutionStore.of({
    record: (input) =>
      Effect.sync(() => {
        const k = key(input.caseId, input.callId);
        if (!rows.has(k)) {
          rows.set(k, {
            caseId: input.caseId,
            callId: input.callId,
            tool: input.tool,
            resultOk: input.resultOk,
            executedAt: new Date(),
          });
        }
      }),
    find: (caseId, callId) =>
      Effect.sync(() => rows.get(key(caseId, callId)) ?? null),
  });
});
