import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TicketId, OrderId, TenantId, ThreadId } from "@support-agent/agent-core";
import {
  WorkflowQueue,
  WorkflowQueueTest,
  workflowEventKey,
  type WorkflowJob,
} from "../src/workflow-queue.js";

const ticketCreated = {
  type: "ticket.created" as const,
  tenantId: TenantId("tenant-1"),
  source: "api" as const,
  payload: {
    subject: "Where is my order?",
    body: "Can you check order 123?",
    customerEmail: "customer@example.com",
    metadata: {},
  },
};

const run = <A, E>(eff: Effect.Effect<A, E, WorkflowQueue>) =>
  Effect.runPromise(Effect.provide(eff, WorkflowQueueTest));

describe("WorkflowQueue (Test layer)", () => {
  it("derives stable serialization keys for known workflow scopes", () => {
    expect(
      workflowEventKey(
        {
          type: "customer.replied",
          ticketId: TicketId("ticket-1"),
          payload: {
            threadId: ThreadId("thread-1"),
            messageId: "message-1",
            from: { name: null, email: "customer@example.com" },
            to: [{ name: null, email: "support@example.com" }],
            subject: "Re: order",
            bodyText: "thanks",
            bodyHtml: null,
            receivedAt: new Date("2026-05-14T00:00:00.000Z"),
            attachments: [],
          },
        },
        "event-1",
      ),
    ).toBe("ticket:ticket-1");

    expect(
      workflowEventKey(
        {
          type: "message.received",
          tenantId: TenantId("tenant-1"),
          threadId: ThreadId("thread-1"),
          payload: {
            threadId: ThreadId("thread-1"),
            messageId: "message-1",
            from: { name: null, email: "customer@example.com" },
            to: [{ name: null, email: "support@example.com" }],
            subject: "order",
            bodyText: "where is it?",
            bodyHtml: null,
            receivedAt: new Date("2026-05-14T00:00:00.000Z"),
            attachments: [],
          },
        },
        "event-2",
      ),
    ).toBe("thread:tenant-1:thread-1");

    expect(
      workflowEventKey(
        {
          type: "tracking.changed",
          orderId: OrderId("order-1"),
          payload: {
            carrier: "ups",
            trackingNumber: "1Z",
            status: "in_transit",
            occurredAt: new Date("2026-05-14T00:00:00.000Z"),
            location: null,
          },
        },
        "event-3",
      ),
    ).toBe("order:order-1");

    expect(workflowEventKey(ticketCreated, "event-4")).toBe("event:event-4");
  });

  it("enqueues jobs and delivers them to a consumer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const queue = yield* WorkflowQueue;
        const received = yield* Deferred.make<WorkflowJob>();
        const consumer = yield* queue.consume((job) =>
          Deferred.succeed(received, job).pipe(Effect.asVoid),
        );
        const enqueued = yield* queue.enqueue(ticketCreated, {
          eventId: "event-1",
        });
        const job = yield* Deferred.await(received);
        yield* consumer.shutdown;
        return { enqueued, job };
      }),
    );

    expect(result.enqueued.jobId).toBe("test-job-1");
    expect(result.enqueued.eventId).toBe("event-1");
    expect(result.job.jobId).toBe("test-job-1");
    expect(result.job.event).toEqual(ticketCreated);
  });
});
