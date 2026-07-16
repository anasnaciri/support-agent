import type { DiscoverShipmentInput, ShipmentStatus } from "./shipment-store.js";

export const SHIPMENT_EVENT_QUEUE = "shipment.events";

export type ShipmentIngestionJob =
  | {
      readonly kind: "shopify.backfill";
      readonly tenantId: string;
    }
  | {
      readonly kind: "shopify.fulfillment";
      readonly shipment: DiscoverShipmentInput;
    }
  | {
      readonly kind: "seventeentrack.update";
      readonly shipmentId: string;
      readonly fingerprint: string;
      readonly status: ShipmentStatus;
      readonly occurredAt: string;
      readonly lastScanAt: string | null;
      readonly transitDays: number | null;
      readonly destinationCountry: string | null;
    };
