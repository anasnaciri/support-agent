import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  EventBus,
  EventBusFromWorkflowQueue,
  WorkflowQueue,
  makeEnqueuedWorkflowEvent,
  type EnqueuedWorkflowEvent,
} from "../src/index.js";

describe("EventBus", () => {
  it("publishes domain events onto the workflow queue", async () => {
    const enqueued: EnqueuedWorkflowEvent[] = [];
    const WorkflowQueueSpy = Layer.succeed(
      WorkflowQueue,
      WorkflowQueue.of({
        enqueue: (event, opts = {}) =>
          Effect.sync(() => {
            const item = makeEnqueuedWorkflowEvent(event, opts, "job-1");
            enqueued.push(item);
            return item;
          }),
        consume: () => Effect.dieMessage("not used"),
      }),
    );
    const TestLayer = EventBusFromWorkflowQueue.pipe(
      Layer.provide(WorkflowQueueSpy),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bus = yield* EventBus;
          const published = yield* bus.publish(
            {
              type: "ticket.created",
              tenantId: TenantId("tenant-1"),
              source: "api",
              payload: {
                subject: "Where is my order?",
                body: "Can you check order 123?",
                customerEmail: "customer@example.com",
                metadata: {},
              },
            },
            { eventId: "event-1" },
          );
          return published;
        }),
        TestLayer,
      ),
    );

    expect(result.eventId).toBe("event-1");
    expect(result.jobId).toBe("job-1");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.event.type).toBe("ticket.created");
  });
});
