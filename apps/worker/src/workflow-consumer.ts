// ============================================================
// Workflow-events consumer — concurrency + per-tick timeout
// ============================================================
//
// The `workflow.events` queue is policy `key_strict_fifo`: pg-boss keeps at
// most one job ACTIVE per `singletonKey` (= `case:<id>` / `thread:<id>`) via a
// unique index, so different cases/threads are safe to run in parallel while a
// single case's events stay strictly ordered.
//
// The consumer historically ran as a SINGLE serial `boss.work()` (default
// `localConcurrency` 1, `batchSize` 1). That threw away the whole point of the
// policy: one slow/hung `message.received` autonomous run held the only work
// slot, and `approval.approved` / `approval.rejected` events for OTHER cases
// starved behind it in `created` state — never dispatched, so approved drafts
// never sent and cases sat in `waiting_for_approval` indefinitely.
//
// This module re-enables the concurrency the queue was designed for, and wraps
// each tick in a wall-clock timeout so a hung run fails → retries (and
// eventually dead-letters into human_takeover) instead of wedging a slot.

import { Cause, Duration, Effect, Exit } from "effect";
import type { DomainEvent, WorkflowResult } from "@support-agent/agent-core";
import { AgentRuntime } from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import { DEFAULT_WORKFLOW_QUEUE_NAME } from "./workflow-queue-live.js";
import { settleWorkflowResult } from "./workflow-job.js";

export interface WorkflowJobData {
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: string;
}

// ---- configuration -----------------------------------------

/**
 * Number of independent workers polling `workflow.events` per node. Must be > 1
 * — a serial consumer is exactly the bug this module fixes. Kept modest so
 * concurrent ticks stay well inside the worker's Postgres pool (default 10;
 * a tick only holds a connection during its short state-write transactions,
 * not across LLM calls).
 */
export const DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY = 4;

/**
 * Wall-clock budget for a single tick. `maxTurnsPerTick` bounds the number of
 * agent turns but NOT their latency, and only individual tool calls are
 * `Effect.timeout`-wrapped — so a hung LLM/connector call could otherwise hold
 * a work slot forever (a prod job ran `active` for 5+ minutes). On timeout the
 * tick is interrupted and settled as a retryable failure.
 */
export const DEFAULT_WORKFLOW_TICK_TIMEOUT_MS = 180_000;

const MAX_CONCURRENCY = 32;
const MIN_TICK_TIMEOUT_MS = 1_000;
const MAX_TICK_TIMEOUT_MS = 900_000;

export interface WorkflowConsumerConfig {
  readonly concurrency: number;
  readonly tickTimeoutMs: number;
}

const clampInt = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export const workflowConsumerConfig = (
  env: Record<string, string | undefined>,
): WorkflowConsumerConfig => ({
  concurrency: clampInt(
    env["WORKFLOW_CONSUMER_CONCURRENCY"],
    DEFAULT_WORKFLOW_CONSUMER_CONCURRENCY,
    1,
    MAX_CONCURRENCY,
  ),
  tickTimeoutMs: clampInt(
    env["WORKFLOW_TICK_TIMEOUT_MS"],
    DEFAULT_WORKFLOW_TICK_TIMEOUT_MS,
    MIN_TICK_TIMEOUT_MS,
    MAX_TICK_TIMEOUT_MS,
  ),
});

// ---- per-event processing ----------------------------------

export type WorkflowEventSettlement =
  | { readonly kind: "complete"; readonly result: WorkflowResult }
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "defect"; readonly detail: string };

/** The slice of `ManagedRuntime` this module needs — eases testing. */
export interface TickRunner {
  readonly runPromiseExit: <A>(
    effect: Effect.Effect<A, never, AgentRuntime>,
  ) => Promise<Exit.Exit<A, never>>;
}

/**
 * Run one workflow event through the AgentRuntime under a wall-clock timeout,
 * and classify the outcome for pg-boss settlement:
 * - `complete` → ack the job (terminal result / pause / non-retryable failure)
 * - `retry`    → throw so pg-boss backs off and retries (transient failure or
 *                a tick that blew its time budget)
 * - `defect`   → throw so pg-boss retries; the caller logs the cause
 */
export const processWorkflowEvent = async (opts: {
  readonly runtime: TickRunner;
  readonly event: DomainEvent;
  readonly tickTimeoutMs: number;
}): Promise<WorkflowEventSettlement> => {
  const { runtime, event, tickTimeoutMs } = opts;
  const tick = Effect.flatMap(AgentRuntime, (r) => r.handleEvent(event)).pipe(
    Effect.timeoutTo({
      duration: Duration.millis(tickTimeoutMs),
      onSuccess: (result: WorkflowResult) => result,
      onTimeout: (): WorkflowResult => ({
        type: "Failed",
        reason: `tick exceeded ${tickTimeoutMs}ms wall-clock budget`,
        retryable: true,
      }),
    }),
  );
  const exit = await runtime.runPromiseExit(tick);
  if (Exit.isSuccess(exit)) {
    const settlement = settleWorkflowResult(exit.value);
    return settlement.kind === "retry"
      ? { kind: "retry", reason: settlement.reason }
      : { kind: "complete", result: exit.value };
  }
  // E is `never`, so a failed exit can only be a defect.
  return { kind: "defect", detail: Cause.pretty(exit.cause) };
};

// ---- registration ------------------------------------------

export interface RegisterWorkflowConsumerOptions {
  readonly boss: PgBoss;
  readonly concurrency: number;
  readonly queueName?: string;
  /** Process one delivered job; throw to trigger pg-boss retry. */
  readonly onJob: (job: { readonly data: WorkflowJobData }) => Promise<void>;
}

/**
 * Register the concurrent `workflow.events` consumer. `localConcurrency` spawns
 * N independent pollers in-process; `key_strict_fifo` keeps same-case events
 * serialized across them. Returns the pg-boss worker id.
 */
export const registerWorkflowConsumer = (
  opts: RegisterWorkflowConsumerOptions,
): Promise<string> =>
  opts.boss.work<WorkflowJobData, void>(
    opts.queueName ?? DEFAULT_WORKFLOW_QUEUE_NAME,
    { localConcurrency: opts.concurrency },
    async (jobs) => {
      for (const job of jobs) {
        await opts.onJob(job);
      }
    },
  );
