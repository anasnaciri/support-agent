import { randomUUID } from "node:crypto";
import { Deferred, Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus, WorkflowQueue, type WorkflowConsumer, type WorkflowJob } from "@support-agent/services";
import { TenantId, ThreadId } from "@support-agent/agent-core";
import { EventBusPgBossLive } from "../src/event-bus-live.js";
import { makeQueue, type PgBoss } from "../src/queue.js";
import { WorkflowQueuePgBossLive } from "../src/workflow-queue-live.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const timeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("workflow queue timeout")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

describeIfDb("EventBusPgBossLive + WorkflowQueuePgBossLive", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = await makeQueue({
      databaseUrl: databaseUrl!,
      schema: "pgboss_workflow_test",
    });
  }, 30_000);

  afterAll(async () => {
    if (boss) {
      await boss.stop({ graceful: true, wait: false });
    }
  });

  it("publishes and consumes a domain event through pg-boss", async () => {
    const queueName = `workflow.test.${randomUUID().replaceAll("-", "")}`;
    const layer = Layer.mergeAll(
      EventBusPgBossLive(boss, { queueName }),
      WorkflowQueuePgBossLive(boss, {
        queueName,
        pollingIntervalSeconds: 0.5,
        batchSize: 1,
      }),
    );
    const received = await Effect.runPromise(Deferred.make<WorkflowJob>());
    let consumer: WorkflowConsumer | null = null;

    try {
      consumer = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const queue = yield* WorkflowQueue;
            return yield* queue.consume((job) =>
              Deferred.succeed(received, job).pipe(Effect.asVoid),
            );
          }),
          layer,
        ),
      );

      const event = {
        type: "email.received" as const,
        tenantId: TenantId("tenant-1"),
        threadId: ThreadId("thread-1"),
        payload: {
          threadId: ThreadId("thread-1"),
          messageId: "message-1",
          from: { name: null, email: "customer@example.com" },
          to: [{ name: null, email: "support@example.com" }],
          subject: "Where is my order?",
          bodyText: "Can you check order 123?",
          bodyHtml: null,
          receivedAt: new Date("2026-05-14T12:00:00.000Z"),
          attachments: [],
        },
      };

      const published = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            return yield* bus.publish(event, { eventId: "event-1" });
          }),
          layer,
        ),
      );
      const job = await timeout(Effect.runPromise(Deferred.await(received)), 10_000);

      expect(published.jobId).toEqual(expect.any(String));
      expect(published.key).toBe("thread:tenant-1:thread-1");
      expect(job.eventId).toBe("event-1");
      expect(job.key).toBe("thread:tenant-1:thread-1");
      expect(job.event.type).toBe("email.received");
      if (job.event.type === "email.received") {
        expect(job.event.payload.receivedAt).toBeInstanceOf(Date);
        expect(job.event.payload.receivedAt.toISOString()).toBe(
          "2026-05-14T12:00:00.000Z",
        );
      }
    } finally {
      if (consumer) {
        await Effect.runPromise(consumer.shutdown);
      }
    }
  }, 30_000);
});
