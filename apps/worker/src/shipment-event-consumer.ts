import { Effect } from "effect";
import {
  ConnectorCredentialStore,
  SHIPMENT_EVENT_QUEUE,
  ShipmentStore,
  type ShipmentIngestionJob,
} from "@support-agent/services";
import {
  seventeenTrackRegister,
  shopifyShipmentBackfill,
} from "@support-agent/providers";
import { TenantId } from "@support-agent/agent-core";
import type { PgBoss } from "./queue.js";

interface RegisterShipmentConsumerOptions {
  readonly boss: PgBoss;
  readonly runShipmentEffect: <A>(
    effect: Effect.Effect<
      A,
      unknown,
      ShipmentStore | ConnectorCredentialStore
    >,
  ) => Promise<A>;
  readonly seventeenTrackApiKey?: string;
}

export const registerShipmentEventConsumer = async (
  opts: RegisterShipmentConsumerOptions,
): Promise<string> => {
  await opts.boss.createQueue(SHIPMENT_EVENT_QUEUE, {
    policy: "standard",
    retryLimit: 5,
    retryBackoff: true,
  });
  return opts.boss.work<ShipmentIngestionJob, void>(
    SHIPMENT_EVENT_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        const data = job.data;
        if (data.kind === "shopify.backfill") {
          const connection = await opts.runShipmentEffect(
            ConnectorCredentialStore.pipe(
              Effect.flatMap((store) =>
                store.get(TenantId(data.tenantId), "shopify"),
              ),
            ),
          );
          await shopifyShipmentBackfill({
            shop: connection.shopDomain,
            accessToken: connection.accessToken,
            apiVersion: connection.apiVersion ?? "2026-04",
            onShipment: async (discovered) => {
              const shipment = await opts.runShipmentEffect(
                ShipmentStore.pipe(
                  Effect.flatMap((store) =>
                    store.discover({
                      tenantId: TenantId(data.tenantId),
                      source: "shopify",
                      ...discovered,
                    }),
                  ),
                ),
              );
              if (opts.seventeenTrackApiKey) {
                await seventeenTrackRegister({
                  apiKey: opts.seventeenTrackApiKey,
                  trackingNumber: shipment.trackingNumber,
                  carrier: shipment.carrier,
                  tag: shipment.id,
                });
              }
            },
          });
          continue;
        }
        if (data.kind === "shopify.fulfillment") {
          const shipment = await opts.runShipmentEffect(
            ShipmentStore.pipe(
              Effect.flatMap((store) => store.discover(data.shipment)),
            ),
          );
          if (opts.seventeenTrackApiKey) {
            await seventeenTrackRegister({
              apiKey: opts.seventeenTrackApiKey,
              trackingNumber: shipment.trackingNumber,
              carrier: shipment.carrier,
              tag: shipment.id,
            });
          }
          continue;
        }
        await opts.runShipmentEffect(
          ShipmentStore.pipe(
            Effect.flatMap((store) =>
              store.recordTracking({
                shipmentId: data.shipmentId,
                provider: "seventeentrack",
                fingerprint: data.fingerprint,
                status: data.status,
                occurredAt: new Date(data.occurredAt),
                lastScanAt: data.lastScanAt
                  ? new Date(data.lastScanAt)
                  : null,
                transitDays: data.transitDays,
                destinationCountry: data.destinationCountry,
              }),
            ),
          ),
        );
      }
    },
  );
};
