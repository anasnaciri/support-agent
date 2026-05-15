import { Effect, Layer } from "effect";
import {
  EventBus,
  EventBusPublishError,
} from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import {
  enqueueWorkflowEvent,
  ensureWorkflowQueue,
  type PgBossWorkflowQueueOptions,
} from "./workflow-queue-live.js";

export const EventBusPgBossLive = (
  boss: PgBoss,
  opts: PgBossWorkflowQueueOptions = {},
) =>
  Layer.succeed(
    EventBus,
    EventBus.of({
      publish: (event, publishOpts = {}) =>
        Effect.gen(function* () {
          yield* ensureWorkflowQueue(boss, opts).pipe(
            Effect.mapError(
              (cause) =>
                new EventBusPublishError({
                  eventType: event.type,
                  cause,
                }),
            ),
          );
          return yield* enqueueWorkflowEvent(
            boss,
            event,
            publishOpts,
            opts,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new EventBusPublishError({
                  eventType: event.type,
                  cause,
                }),
            ),
          );
        }),
    }),
  );
