import { Context, Data, Effect, Fiber, Layer, Queue, Ref } from "effect";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@support-agent/agent-core";

// ============================================================
// Errors
// ============================================================

export class WorkflowQueueBackendError extends Data.TaggedError(
  "WorkflowQueueBackendError",
)<{
  readonly operation: "enqueue" | "consume" | "shutdown" | "ensure_queue";
  readonly cause: unknown;
}> {}

export type WorkflowQueueError = WorkflowQueueBackendError;

// ============================================================
// Types
// ============================================================

export interface WorkflowEnqueueOptions {
  readonly eventId?: string;
  readonly key?: string;
  readonly priority?: number;
  readonly startAfter?: Date;
}

export interface EnqueuedWorkflowEvent {
  readonly jobId: string | null;
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: Date;
}

export interface WorkflowJob {
  readonly jobId: string;
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: Date;
}

export interface WorkflowConsumer {
  readonly id: string;
  readonly shutdown: Effect.Effect<void, WorkflowQueueError>;
}

export type WorkflowQueueHandler = (
  job: WorkflowJob,
) => Effect.Effect<void, unknown, never>;

// ============================================================
// Helpers
// ============================================================

export const workflowEventKey = (
  event: DomainEvent,
  eventId: string,
): string => {
  switch (event.type) {
    case "email.received":
      return `thread:${event.tenantId}:${event.threadId}`;
    case "customer.replied":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return `case:${event.caseId}`;
    case "approval.approved":
    case "approval.rejected":
      return `case:${event.caseId}`;
    case "tracking.changed":
      return `order:${event.orderId}`;
    case "ticket.created":
      return `event:${eventId}`;
  }
};

export const makeEnqueuedWorkflowEvent = (
  event: DomainEvent,
  opts: WorkflowEnqueueOptions = {},
  jobId: string | null = null,
): EnqueuedWorkflowEvent => {
  const eventId = opts.eventId ?? randomUUID();
  return {
    jobId,
    eventId,
    event,
    key: opts.key ?? workflowEventKey(event, eventId),
    enqueuedAt: new Date(),
  };
};

// ============================================================
// Tag
// ============================================================

export class WorkflowQueue extends Context.Tag("WorkflowQueue")<
  WorkflowQueue,
  {
    readonly enqueue: (
      event: DomainEvent,
      opts?: WorkflowEnqueueOptions,
    ) => Effect.Effect<EnqueuedWorkflowEvent, WorkflowQueueError>;

    readonly consume: (
      handler: WorkflowQueueHandler,
    ) => Effect.Effect<WorkflowConsumer, WorkflowQueueError>;
  }
>() {}

// ============================================================
// Test layer — in-memory FIFO queue with async consumers
// ============================================================

export const WorkflowQueueTest = Layer.effect(
  WorkflowQueue,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<WorkflowJob>();
    const nextJobId = yield* Ref.make(1);

    return WorkflowQueue.of({
      enqueue: (event, opts = {}) =>
        Effect.gen(function* () {
          const n = yield* Ref.getAndUpdate(nextJobId, (current) => current + 1);
          const jobId = `test-job-${n}`;
          const enqueued = makeEnqueuedWorkflowEvent(event, opts, jobId);
          const job: WorkflowJob = {
            jobId,
            eventId: enqueued.eventId,
            event: enqueued.event,
            key: enqueued.key,
            enqueuedAt: enqueued.enqueuedAt,
          };
          yield* Queue.offer(queue, job);
          return enqueued;
        }),

      consume: (handler) =>
        Effect.gen(function* () {
          const processOne = Queue.take(queue).pipe(
            Effect.flatMap(handler),
            Effect.catchAllCause(() => Effect.void),
          );
          const fiber = yield* processOne.pipe(Effect.forever, Effect.fork);
          return {
            id: randomUUID(),
            shutdown: Fiber.interrupt(fiber).pipe(Effect.asVoid),
          };
        }),
    });
  }),
);
