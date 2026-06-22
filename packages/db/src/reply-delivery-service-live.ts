import { Effect, FiberRef, Layer } from "effect";
import {
  ReplyDeliveryService,
  ReplyDeliveryWriteFailed,
  nextReplyDeliveryBackoffMs,
} from "@support-agent/services";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { enqueueReplyDelivery } from "./reply-delivery-store.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

/**
 * Live `ReplyDeliveryService` over Postgres. Persists a failed customer-reply
 * send into the `reply_deliveries` outbox, scheduling the first retry one
 * backoff step out. A re-run of the same failed draft upserts the existing
 * pending row (store-level dedupe). A genuine DB write failure fails the Effect
 * with a transient `ReplyDeliveryWriteFailed`.
 */
export const ReplyDeliveryServiceLive = Layer.effect(
  ReplyDeliveryService,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return ReplyDeliveryService.of({
      enqueue: (input) =>
        Effect.gen(function* () {
          const activeDb = yield* useDb(db);
          return yield* Effect.tryPromise({
            try: () =>
              enqueueReplyDelivery(activeDb, {
                tenantId: input.tenantId,
                caseId: input.caseId,
                agentId: String(input.agentId),
                tool: input.tool,
                mailbox: input.mailbox,
                draftId: input.draftId,
                draft: input.draft,
                error: input.error,
                nextAttemptAt: new Date(
                  Date.now() + nextReplyDeliveryBackoffMs(1),
                ),
              }),
            catch: (cause) => new ReplyDeliveryWriteFailed({ cause }),
          });
        }),
    });
  }),
);
