import { Context, Data, Effect } from "effect";
import type { TenantId } from "@support-agent/agent-core";

export type ShipmentStatus =
  | "pending"
  | "in_transit"
  | "delivered"
  | "exception"
  | "unknown"
  | "stopped";

export interface Shipment {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly source: "shopify";
  readonly sourceOrderId: string;
  readonly sourceFulfillmentId: string;
  readonly trackingNumber: string;
  readonly carrier: string | null;
  readonly status: ShipmentStatus;
}

export interface DiscoverShipmentInput {
  readonly tenantId: TenantId;
  readonly source: "shopify";
  readonly sourceOrderId: string;
  readonly sourceFulfillmentId: string;
  readonly trackingNumber: string;
  readonly carrier?: string | null;
  readonly shippedAt?: Date | null;
}

export interface RecordShipmentTrackingInput {
  readonly shipmentId: string;
  readonly provider: "seventeentrack";
  /** Stable hash of the normalized provider event; makes retries idempotent. */
  readonly fingerprint: string;
  readonly status: ShipmentStatus;
  readonly occurredAt: Date;
  readonly lastScanAt?: Date | null;
  readonly transitDays?: number | null;
  readonly destinationCountry?: string | null;
}

export class ShipmentStoreError extends Data.TaggedError("ShipmentStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class ShipmentStore extends Context.Tag("ShipmentStore")<
  ShipmentStore,
  {
    readonly discover: (
      input: DiscoverShipmentInput,
    ) => Effect.Effect<Shipment, ShipmentStoreError>;
    readonly recordTracking: (
      input: RecordShipmentTrackingInput,
    ) => Effect.Effect<"recorded" | "duplicate" | "not_found", ShipmentStoreError>;
  }
>() {}
