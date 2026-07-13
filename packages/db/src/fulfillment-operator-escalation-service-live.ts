import { Effect, Layer } from "effect";
import {
  FulfillmentOperatorEscalationService,
  FulfillmentOperatorEscalationWriteFailed,
} from "@support-agent/services";
import { DbClient } from "./db-client.js";
import {
  getDefaultFulfillmentOperator,
  hasOpenEscalationForTicket,
  insertEscalation,
} from "./fulfillment-operator-store.js";

/**
 * Live `FulfillmentOperatorEscalationService` over Postgres. Resolves the workspace's
 * default fulfillmentOperator and inserts the `ticket_fulfillment_operator_escalations` row with the
 * agent-supplied privacy projection. Returns `no_fulfillment_operator` (a normal result,
 * NOT an error) when the workspace has no fulfillmentOperator, so the agent falls back to a
 * direct reply instead of retrying; only a genuine DB write failure fails the
 * Effect (the agent retries that). The runtime parks the ticket in
 * `waiting_for_fulfillment_operator` only on an `escalated` result.
 */
export const FulfillmentOperatorEscalationServiceLive = Layer.effect(
  FulfillmentOperatorEscalationService,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return FulfillmentOperatorEscalationService.of({
      escalate: (input) =>
        Effect.gen(function* () {
          const fulfillmentOperator = yield* Effect.tryPromise({
            try: () => getDefaultFulfillmentOperator(db, input.tenantId),
            catch: (cause) => new FulfillmentOperatorEscalationWriteFailed({ cause }),
          });
          if (!fulfillmentOperator) {
            return { kind: "no_fulfillment_operator" as const };
          }
          const { id } = yield* Effect.tryPromise({
            try: () =>
              insertEscalation(db, {
                tenantId: input.tenantId,
                ticketId: input.ticketId,
                fulfillmentOperatorId: fulfillmentOperator.id,
                problem: input.problem,
                orderRef: input.orderRef,
                shipCity: input.shipCity,
                shipCountry: input.shipCountry,
                trackingNumber: input.trackingNumber,
              }),
            catch: (cause) => new FulfillmentOperatorEscalationWriteFailed({ cause }),
          });
          return {
            kind: "escalated" as const,
            escalationId: id,
            fulfillmentOperatorId: fulfillmentOperator.id,
            fulfillmentOperatorEmail: fulfillmentOperator.email,
          };
        }),
      hasOpenEscalationForTicket: (tenantId, ticketId) =>
        Effect.tryPromise({
          try: () => hasOpenEscalationForTicket(db, tenantId, ticketId),
          catch: (cause) => new FulfillmentOperatorEscalationWriteFailed({ cause }),
        }),
    });
  }),
);
