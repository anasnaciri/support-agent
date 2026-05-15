import { Context, Data, Effect, Layer } from "effect";
import type { DomainEvent, DomainEventType } from "@support-agent/agent-core";
import {
  WorkflowQueue,
  WorkflowQueueTest,
  type EnqueuedWorkflowEvent,
  type WorkflowEnqueueOptions,
} from "./workflow-queue.js";

// ============================================================
// Errors
// ============================================================

export class EventBusPublishError extends Data.TaggedError(
  "EventBusPublishError",
)<{
  readonly eventType: DomainEventType;
  readonly cause: unknown;
}> {}

export type EventBusError = EventBusPublishError;

// ============================================================
// Types
// ============================================================

export type EventBusPublishOptions = WorkflowEnqueueOptions;
export type PublishedDomainEvent = EnqueuedWorkflowEvent;

// ============================================================
// Tag
// ============================================================

export class EventBus extends Context.Tag("EventBus")<
  EventBus,
  {
    readonly publish: (
      event: DomainEvent,
      opts?: EventBusPublishOptions,
    ) => Effect.Effect<PublishedDomainEvent, EventBusError>;
  }
>() {}

// ============================================================
// Layer — publish domain events onto the workflow queue
// ============================================================

export const EventBusFromWorkflowQueue = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const queue = yield* WorkflowQueue;
    return EventBus.of({
      publish: (event, opts = {}) =>
        queue.enqueue(event, opts).pipe(
          Effect.mapError(
            (cause) =>
              new EventBusPublishError({
                eventType: event.type,
                cause,
              }),
          ),
        ),
    });
  }),
);

export const EventBusTest = EventBusFromWorkflowQueue.pipe(
  Layer.provide(WorkflowQueueTest),
);
