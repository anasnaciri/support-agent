import type { TenantId } from "@support-agent/agent-core";
import type { RegisteredWebhook } from "./webhook-registration.js";

export const SHOPIFY_SHIPMENT_ROLLOUT_VERSION = "shipment-analytics-v1";

export interface ShopifyShipmentRolloutTarget {
  readonly tenantId: TenantId;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly apiVersion: string;
}

interface ReconciliationDependencies {
  readonly registerWebhooks: (
    target: ShopifyShipmentRolloutTarget,
  ) => Promise<ReadonlyArray<RegisteredWebhook>>;
  readonly enqueueBackfill: (
    target: ShopifyShipmentRolloutTarget,
  ) => Promise<void>;
  readonly markComplete: (
    target: ShopifyShipmentRolloutTarget,
    webhooks: ReadonlyArray<RegisteredWebhook>,
  ) => Promise<void>;
}

export interface ShopifyShipmentRolloutSummary {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: ReadonlyArray<{
    readonly tenantId: string;
    readonly shopDomain: string;
    readonly error: string;
  }>;
}

export const shopifyShipmentRolloutMetadata = (
  webhooks: ReadonlyArray<RegisteredWebhook>,
  reconciledAt = new Date(),
): Readonly<Record<string, unknown>> => ({
  shopifyShipmentRollout: {
    version: SHOPIFY_SHIPMENT_ROLLOUT_VERSION,
    reconciledAt: reconciledAt.toISOString(),
    webhooks: webhooks.map((webhook) => ({
      topic: webhook.topic,
      id: webhook.id,
      uri: webhook.uri,
      status: webhook.status,
    })),
  },
});

export const reconcileShopifyShipmentRollout = async (
  targets: ReadonlyArray<ShopifyShipmentRolloutTarget>,
  deps: ReconciliationDependencies,
): Promise<ShopifyShipmentRolloutSummary> => {
  let completed = 0;
  const failed: Array<ShopifyShipmentRolloutSummary["failed"][number]> = [];
  for (const target of targets) {
    try {
      const webhooks = await deps.registerWebhooks(target);
      await deps.enqueueBackfill(target);
      await deps.markComplete(target, webhooks);
      completed += 1;
    } catch (cause) {
      failed.push({
        tenantId: target.tenantId,
        shopDomain: target.shopDomain,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { attempted: targets.length, completed, failed };
};
