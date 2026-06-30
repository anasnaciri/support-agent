import { Effect, Layer } from "effect";
import type {
  Queue as PgBossQueue,
  QueuePolicy,
  SendOptions,
  WorkOptions,
} from "pg-boss";
import type { DomainEvent } from "@support-agent/agent-core";
import {
  WorkflowQueue,
  WorkflowQueueBackendError,
  makeEnqueuedWorkflowEvent,
  type EnqueuedWorkflowEvent,
  type WorkflowEnqueueOptions,
  type WorkflowJob,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";

export const DEFAULT_WORKFLOW_QUEUE_NAME = "workflow.events";
export const DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE = "workflow.events.dead";

// With `key_strict_fifo`, a job in `failed` state holds the partial unique
// index slot (pg-boss job_i8 covers active|retry|failed), blocking every
// subsequent event for that case/thread key until the row is deleted.
// The pg-boss default retention is 7 days — far too long for a poison
// message to block a customer conversation (audit L11). One hour keeps the
// blockage bounded; the dead-letter consumer escalates the case to a human
// immediately on exhaustion regardless.
const DEFAULT_DELETE_AFTER_SECONDS = 3600;

export interface PgBossWorkflowQueueOptions {
  readonly queueName?: string;
  readonly queuePolicy?: QueuePolicy;
  readonly retryLimit?: number;
  readonly retryDelay?: number;
  readonly retryBackoff?: boolean;
  readonly expireInSeconds?: number;
  readonly retentionSeconds?: number;
  readonly deleteAfterSeconds?: number;
  readonly deadLetter?: string | null;
  readonly pollingIntervalSeconds?: number;
  readonly batchSize?: number;
}

interface WorkflowJobData {
  readonly eventId: string;
  readonly event: DomainEvent;
  readonly key: string;
  readonly enqueuedAt: string;
}

const queueName = (opts: PgBossWorkflowQueueOptions): string =>
  opts.queueName ?? DEFAULT_WORKFLOW_QUEUE_NAME;

const createQueueOptions = (
  opts: PgBossWorkflowQueueOptions,
): Omit<PgBossQueue, "name"> => {
  const out: Omit<PgBossQueue, "name"> = {
    policy: opts.queuePolicy ?? "key_strict_fifo",
    retryLimit: opts.retryLimit ?? 5,
    retryBackoff: opts.retryBackoff ?? true,
    deleteAfterSeconds: opts.deleteAfterSeconds ?? DEFAULT_DELETE_AFTER_SECONDS,
  };
  if (opts.retryDelay !== undefined) out.retryDelay = opts.retryDelay;
  if (opts.expireInSeconds !== undefined)
    out.expireInSeconds = opts.expireInSeconds;
  if (opts.retentionSeconds !== undefined)
    out.retentionSeconds = opts.retentionSeconds;
  // `null` opts out of dead-lettering (tests); undefined gets the default.
  const deadLetter =
    opts.deadLetter === undefined
      ? DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE
      : opts.deadLetter;
  if (deadLetter) out.deadLetter = deadLetter;
  return out;
};

const updateQueueOptions = (
  opts: Omit<PgBossQueue, "name">,
): Omit<PgBossQueue, "name" | "partition" | "policy"> => {
  const { partition: _partition, policy: _policy, ...updatable } = opts;
  return updatable;
};

const sendOptions = (
  enqueued: EnqueuedWorkflowEvent,
  opts: WorkflowEnqueueOptions,
): SendOptions => {
  const out: SendOptions = { singletonKey: enqueued.key };
  if (opts.priority !== undefined) out.priority = opts.priority;
  if (opts.startAfter !== undefined) out.startAfter = opts.startAfter;
  return out;
};

const workOptions = (opts: PgBossWorkflowQueueOptions): WorkOptions => {
  const out: WorkOptions = {};
  if (opts.pollingIntervalSeconds !== undefined) {
    out.pollingIntervalSeconds = opts.pollingIntervalSeconds;
  }
  if (opts.batchSize !== undefined) out.batchSize = opts.batchSize;
  return out;
};

export const reviveDomainEvent = (event: DomainEvent): DomainEvent => {
  switch (event.type) {
    case "message.received":
    case "customer.replied":
      return {
        ...event,
        payload: {
          ...event.payload,
          receivedAt: new Date(event.payload.receivedAt),
        },
      };
    case "tracking.changed":
      return {
        ...event,
        payload: {
          ...event.payload,
          occurredAt: new Date(event.payload.occurredAt),
        },
      };
    case "ticket.created":
    case "approval.approved":
    case "approval.rejected":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return event;
  }
};

const toWorkflowJob = (jobId: string, data: WorkflowJobData): WorkflowJob => ({
  jobId,
  eventId: data.eventId,
  event: reviveDomainEvent(data.event),
  key: data.key,
  enqueuedAt: new Date(data.enqueuedAt),
});

const toJobData = (enqueued: EnqueuedWorkflowEvent): WorkflowJobData => ({
  eventId: enqueued.eventId,
  event: enqueued.event,
  key: enqueued.key,
  enqueuedAt: enqueued.enqueuedAt.toISOString(),
});

const wrap = <A>(
  operation: WorkflowQueueBackendError["operation"],
  promise: Promise<A>,
): Effect.Effect<A, WorkflowQueueBackendError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new WorkflowQueueBackendError({ operation, cause }),
  });

export const ensureWorkflowQueue = (
  boss: PgBoss,
  opts: PgBossWorkflowQueueOptions = {},
): Effect.Effect<void, WorkflowQueueBackendError> =>
  Effect.gen(function* () {
    const queueOpts = createQueueOptions(opts);
    // The dead-letter target must exist before a queue can reference it.
    if (queueOpts.deadLetter) {
      const deadLetterOpts = {
        policy: "standard" as const,
        retryLimit: 3,
        retryBackoff: true,
      };
      yield* wrap(
        "ensure_queue",
        boss.createQueue(queueOpts.deadLetter, deadLetterOpts),
      );
      yield* wrap(
        "ensure_queue",
        boss.updateQueue(
          queueOpts.deadLetter,
          updateQueueOptions(deadLetterOpts),
        ),
      );
    }
    yield* wrap(
      "ensure_queue",
      boss.createQueue(queueName(opts), queueOpts),
    );
    yield* wrap(
      "ensure_queue",
      boss.updateQueue(queueName(opts), updateQueueOptions(queueOpts)),
    );
  });

export const enqueueWorkflowEvent = (
  boss: PgBoss,
  event: DomainEvent,
  enqueueOpts: WorkflowEnqueueOptions = {},
  queueOpts: PgBossWorkflowQueueOptions = {},
): Effect.Effect<EnqueuedWorkflowEvent, WorkflowQueueBackendError> =>
  Effect.gen(function* () {
    const enqueued = makeEnqueuedWorkflowEvent(event, enqueueOpts);
    const jobId = yield* wrap(
      "enqueue",
      boss.send(
        queueName(queueOpts),
        toJobData(enqueued),
        sendOptions(enqueued, enqueueOpts),
      ),
    );
    return { ...enqueued, jobId };
  });

export const WorkflowQueuePgBossLive = (
  boss: PgBoss,
  opts: PgBossWorkflowQueueOptions = {},
) =>
  Layer.effect(
    WorkflowQueue,
    Effect.gen(function* () {
      yield* ensureWorkflowQueue(boss, opts);

      return WorkflowQueue.of({
        enqueue: (event, enqueueOpts = {}) =>
          enqueueWorkflowEvent(boss, event, enqueueOpts, opts),

        consume: (handler) =>
          Effect.gen(function* () {
            const id = yield* wrap(
              "consume",
              boss.work<WorkflowJobData, void>(
                queueName(opts),
                workOptions(opts),
                async (jobs) => {
                  for (const job of jobs) {
                    await Effect.runPromise(
                      handler(toWorkflowJob(job.id, job.data)),
                    );
                  }
                },
              ),
            );

            return {
              id,
              shutdown: wrap("shutdown", boss.offWork(queueName(opts), { id })),
            };
          }),
      });
    }),
  );
