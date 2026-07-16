import { Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import {
  ShipmentStore,
  ShipmentStoreError,
  type Shipment,
} from "@support-agent/services";
import { DbClient } from "./db-client.js";
import { shipmentEvents, shipments } from "./schema.js";

const toShipment = (row: typeof shipments.$inferSelect): Shipment => ({
  id: row.id,
  tenantId: row.tenantId as Shipment["tenantId"],
  source: "shopify",
  sourceOrderId: row.sourceOrderId,
  sourceFulfillmentId: row.sourceFulfillmentId,
  trackingNumber: row.trackingNumber,
  carrier: row.carrier,
  status: row.status as Shipment["status"],
});

export const ShipmentStoreLive = Layer.effect(
  ShipmentStore,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const wrap = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new ShipmentStoreError({ operation, cause }),
      });

    return ShipmentStore.of({
      discover: (input) =>
        wrap("discover", async () => {
          const rows = await db
            .insert(shipments)
            .values({
              tenantId: input.tenantId,
              source: input.source,
              sourceOrderId: input.sourceOrderId,
              sourceFulfillmentId: input.sourceFulfillmentId,
              trackingNumber: input.trackingNumber,
              carrier: input.carrier ?? null,
              shippedAt: input.shippedAt ?? null,
            })
            .onConflictDoUpdate({
              target: [
                shipments.tenantId,
                shipments.source,
                shipments.sourceFulfillmentId,
                shipments.trackingNumber,
              ],
              set: {
                sourceOrderId: input.sourceOrderId,
                carrier: input.carrier ?? null,
                shippedAt: input.shippedAt ?? null,
                updatedAt: new Date(),
              },
            })
            .returning();
          return toShipment(rows[0]!);
        }),
      recordTracking: (input) =>
        wrap("recordTracking", async () =>
          db.transaction(async (tx) => {
            const current = (
              await tx
                .select()
                .from(shipments)
                .where(eq(shipments.id, input.shipmentId))
                .for("update")
                .limit(1)
            )[0];
            if (!current) return "not_found" as const;
            const inserted = await tx
              .insert(shipmentEvents)
              .values({
                shipmentId: input.shipmentId,
                provider: input.provider,
                fingerprint: input.fingerprint,
                status: input.status,
                occurredAt: input.occurredAt,
              })
              .onConflictDoNothing({
                target: [
                  shipmentEvents.shipmentId,
                  shipmentEvents.fingerprint,
                ],
              })
              .returning({ id: shipmentEvents.id });
            if (inserted.length === 0) return "duplicate" as const;
            const deliveredAt =
              input.status === "delivered" &&
              (!current.deliveredAt ||
                input.occurredAt.getTime() < current.deliveredAt.getTime())
                ? input.occurredAt
                : current.deliveredAt;
            const firstExceptionAt =
              input.status === "exception" &&
              (!current.firstExceptionAt ||
                input.occurredAt.getTime() <
                  current.firstExceptionAt.getTime())
                ? input.occurredAt
                : current.firstExceptionAt;
            const trackingStoppedAt =
              input.status === "stopped" &&
              (!current.trackingStoppedAt ||
                input.occurredAt.getTime() <
                  current.trackingStoppedAt.getTime())
                ? input.occurredAt
                : current.trackingStoppedAt;
            if (
              current.lastEventAt &&
              current.lastEventAt.getTime() > input.occurredAt.getTime()
            ) {
              if (
                deliveredAt !== current.deliveredAt ||
                firstExceptionAt !== current.firstExceptionAt ||
                trackingStoppedAt !== current.trackingStoppedAt
              ) {
                await tx
                  .update(shipments)
                  .set({
                    deliveredAt,
                    firstExceptionAt,
                    trackingStoppedAt,
                    updatedAt: new Date(),
                  })
                  .where(eq(shipments.id, input.shipmentId));
              }
              return "recorded" as const;
            }
            await tx
              .update(shipments)
              .set({
                status: input.status,
                lastEventAt: input.occurredAt,
                lastScanAt: input.lastScanAt ?? null,
                transitDays: input.transitDays ?? null,
                destinationCountry: input.destinationCountry ?? null,
                deliveredAt,
                firstExceptionAt,
                trackingStoppedAt,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(shipments.id, input.shipmentId),
                  eq(shipments.tenantId, current.tenantId),
                ),
              );
            return "recorded" as const;
          }),
        ),
    });
  }),
);
