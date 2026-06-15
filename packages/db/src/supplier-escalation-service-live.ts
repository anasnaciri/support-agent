import { Effect, Layer } from "effect";
import {
  SupplierEscalationService,
  SupplierEscalationWriteFailed,
  SupplierNotConfigured,
} from "@support-agent/services";
import { DbClient } from "./db-client.js";
import { getDefaultSupplier, insertEscalation } from "./supplier-store.js";

/**
 * Live `SupplierEscalationService` over Postgres. Resolves the workspace's
 * default supplier and inserts the `case_supplier_escalations` row with the
 * agent-supplied privacy projection. Fails with `SupplierNotConfigured` when the
 * workspace has no supplier (the tool maps that to a structured tool result the
 * agent can recover from). The runtime then parks the case in
 * `waiting_for_supplier` (producer branch in agent-runtime).
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
            return yield* Effect.fail(
              new SupplierNotConfigured({ tenantId: input.tenantId }),
            );
          }
          const { id } = yield* Effect.tryPromise({
            try: () =>
              insertEscalation(db, {
                tenantId: input.tenantId,
                caseId: input.caseId,
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
            escalationId: id,
            supplierId: supplier.id,
            supplierEmail: supplier.email,
          };
        }),
    });
  }),
);
