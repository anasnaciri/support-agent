import { Effect, Layer } from "effect";
import {
  SupplierEscalationService,
  SupplierEscalationWriteFailed,
} from "@support-agent/services";
import { DbClient } from "./db-client.js";
import {
  getDefaultSupplier,
  hasOpenEscalationForTicket,
  insertEscalation,
} from "./supplier-store.js";

/**
 * Live `SupplierEscalationService` over Postgres. Resolves the workspace's
 * default supplier and inserts the `ticket_supplier_escalations` row with the
 * agent-supplied privacy projection. Returns `no_supplier` (a normal result,
 * NOT an error) when the workspace has no supplier, so the agent falls back to a
 * direct reply instead of retrying; only a genuine DB write failure fails the
 * Effect (the agent retries that). The runtime parks the ticket in
 * `waiting_for_supplier` only on an `escalated` result.
 */
export const SupplierEscalationServiceLive = Layer.effect(
  SupplierEscalationService,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return SupplierEscalationService.of({
      escalate: (input) =>
        Effect.gen(function* () {
          const supplier = yield* Effect.tryPromise({
            try: () => getDefaultSupplier(db, input.tenantId),
            catch: (cause) => new SupplierEscalationWriteFailed({ cause }),
          });
          if (!supplier) {
            return { kind: "no_supplier" as const };
          }
          const { id } = yield* Effect.tryPromise({
            try: () =>
              insertEscalation(db, {
                tenantId: input.tenantId,
                ticketId: input.ticketId,
                supplierId: supplier.id,
                problem: input.problem,
                orderRef: input.orderRef,
                shipCity: input.shipCity,
                shipCountry: input.shipCountry,
                trackingNumber: input.trackingNumber,
              }),
            catch: (cause) => new SupplierEscalationWriteFailed({ cause }),
          });
          return {
            kind: "escalated" as const,
            escalationId: id,
            supplierId: supplier.id,
            supplierEmail: supplier.email,
          };
        }),
      hasOpenEscalationForTicket: (tenantId, ticketId) =>
        Effect.tryPromise({
          try: () => hasOpenEscalationForTicket(db, tenantId, ticketId),
          catch: (cause) => new SupplierEscalationWriteFailed({ cause }),
        }),
    });
  }),
);
