import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import { ShipmentStore } from "@support-agent/services";
import {
  DbClientLive,
  ShipmentStoreLive,
  makeDbClient,
  shipmentEvents,
  shipments,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ShipmentStoreLive (integration)", () => {
  const raw = makeDbClient({ databaseUrl: databaseUrl! });
  const tenantId = randomUUID();
  const layer = ShipmentStoreLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  afterAll(async () => {
    await raw.db.delete(tenants).where(eq(tenants.id, tenantId));
    await raw.close();
  });

  it("discovers idempotently and records tracking history without regressing current state", async () => {
    await raw.db.insert(tenants).values({ id: tenantId, name: "shipments" });
    const shipment = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShipmentStore;
          const first = yield* store.discover({
            tenantId: TenantId(tenantId),
            source: "shopify",
            sourceOrderId: "gid://shopify/Order/1",
            sourceFulfillmentId: "gid://shopify/Fulfillment/1",
            trackingNumber: "TRACK-1",
            carrier: "Carrier",
            shippedAt: new Date("2026-07-01T00:00:00Z"),
          });
          const second = yield* store.discover({
            tenantId: TenantId(tenantId),
            source: "shopify",
            sourceOrderId: "gid://shopify/Order/1",
            sourceFulfillmentId: "gid://shopify/Fulfillment/1",
            trackingNumber: "TRACK-1",
            carrier: "Updated carrier",
            shippedAt: new Date("2026-07-01T00:00:00Z"),
          });
          expect(second.id).toBe(first.id);
          yield* store.recordTracking({
            shipmentId: first.id,
            provider: "seventeentrack",
            fingerprint: "delivered",
            status: "delivered",
            occurredAt: new Date("2026-07-10T00:00:00Z"),
            lastScanAt: new Date("2026-07-10T00:00:00Z"),
            transitDays: 9,
            destinationCountry: "US",
          });
          yield* store.recordTracking({
            shipmentId: first.id,
            provider: "seventeentrack",
            fingerprint: "older-transit",
            status: "in_transit",
            occurredAt: new Date("2026-07-05T00:00:00Z"),
          });
          yield* store.recordTracking({
            shipmentId: first.id,
            provider: "seventeentrack",
            fingerprint: "older-exception",
            status: "exception",
            occurredAt: new Date("2026-07-08T00:00:00Z"),
          });
          expect(
            yield* store.recordTracking({
              shipmentId: first.id,
              provider: "seventeentrack",
              fingerprint: "delivered",
              status: "delivered",
              occurredAt: new Date("2026-07-10T00:00:00Z"),
            }),
          ).toBe("duplicate");
          return first;
        }),
        layer,
      ),
    );

    const row = (
      await raw.db
        .select()
        .from(shipments)
        .where(eq(shipments.id, shipment.id))
    )[0]!;
    expect(row.status).toBe("delivered");
    expect(row.carrier).toBe("Updated carrier");
    expect(row.transitDays).toBe(9);
    expect(row.deliveredAt?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
    expect(row.firstExceptionAt?.toISOString()).toBe(
      "2026-07-08T00:00:00.000Z",
    );
    expect(
      await raw.db
        .select()
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipment.id)),
    ).toHaveLength(3);
  });
});
