import {
  SHIPMENT_EVENT_QUEUE,
  type ShipmentIngestionJob,
} from "@support-agent/services";

export interface ShipmentBossLike {
  readonly createQueue: (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly send: (name: string, data: any, options?: any) => Promise<unknown>;
}

export const makePgBossShipmentPublisher = (
  acquireBoss: () => Promise<ShipmentBossLike>,
): ((data: ShipmentIngestionJob) => Promise<string | null>) => {
  let ensured = false;
  return async (data) => {
    const boss = await acquireBoss();
    if (!ensured) {
      await boss.createQueue(SHIPMENT_EVENT_QUEUE, {
        policy: "standard",
        retryLimit: 5,
        retryBackoff: true,
      });
      ensured = true;
    }
    const singletonKey =
      data.kind === "shopify.backfill"
        ? `backfill:${data.tenantId}`
        : data.kind === "shopify.fulfillment"
        ? [
            data.shipment.tenantId,
            data.shipment.sourceFulfillmentId,
            data.shipment.trackingNumber,
          ].join(":")
        : `${data.shipmentId}:${data.fingerprint}`;
    const id = await boss.send(SHIPMENT_EVENT_QUEUE, data, { singletonKey });
    return typeof id === "string" ? id : null;
  };
};
