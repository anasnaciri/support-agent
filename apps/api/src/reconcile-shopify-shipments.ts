import { Effect, Layer, ManagedRuntime } from "effect";
import { TenantId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  parseKeySet,
} from "@support-agent/services";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  makeDbClient,
  shopifyShipmentRolloutCandidates,
} from "@support-agent/db";
import {
  fulfillmentWebhookUrls,
  registerFulfillmentWebhooks,
} from "./features/shopify/webhook-registration.js";
import {
  reconcileShopifyShipmentRollout,
  SHOPIFY_SHIPMENT_ROLLOUT_VERSION,
  shopifyShipmentRolloutMetadata,
} from "./features/shopify/shipment-rollout-reconciliation.js";
import {
  shipmentPublisher,
  stopApprovalBoss,
} from "./platform/pgboss.js";

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const main = async (): Promise<void> => {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const callbackUrl = requiredEnv("SHOPIFY_APP_CALLBACK_URL");
  const encryptionKeys = parseKeySet(
    requiredEnv("CREDENTIAL_ENCRYPTION_KEY"),
    process.env["CREDENTIAL_ENCRYPTION_KEY_PREVIOUS"],
  );
  const defaultApiVersion =
    process.env["SHOPIFY_API_VERSION"]?.trim() || "2026-04";
  const raw = makeDbClient({ databaseUrl, maxConnections: 2 });
  const runtime = ManagedRuntime.make(
    ConnectorCredentialStoreLive(encryptionKeys).pipe(
      Layer.provide(DbClientLive({ databaseUrl, maxConnections: 2 })),
    ),
  );
  try {
    const candidates = await shopifyShipmentRolloutCandidates(
      raw.db,
      SHOPIFY_SHIPMENT_ROLLOUT_VERSION,
    );
    const targets = await Promise.all(
      candidates.map(async (candidate) => {
        const connection = await runtime.runPromise(
          ConnectorCredentialStore.pipe(
            Effect.flatMap((store) =>
              store.get(
                TenantId(candidate.tenantId),
                "shopify",
                candidate.shopDomain,
              ),
            ),
          ),
        );
        return {
          tenantId: TenantId(candidate.tenantId),
          shopDomain: candidate.shopDomain,
          accessToken: connection.accessToken,
          apiVersion: connection.apiVersion ?? defaultApiVersion,
          scopes: connection.scopes,
        };
      }),
    );
    const webhookUrls = fulfillmentWebhookUrls(callbackUrl);
    const summary = await reconcileShopifyShipmentRollout(targets, {
      registerWebhooks: (target) =>
        registerFulfillmentWebhooks({
          shop: target.shopDomain,
          accessToken: target.accessToken,
          apiVersion: target.apiVersion,
          webhookUrls,
        }),
      enqueueBackfill: async (target) => {
        await shipmentPublisher(databaseUrl)({
          kind: "shopify.backfill",
          tenantId: target.tenantId,
        });
      },
      markComplete: async (target, webhooks) => {
        await runtime.runPromise(
          ConnectorCredentialStore.pipe(
            Effect.flatMap((store) =>
              store.patchMetadata({
                tenantId: target.tenantId,
                provider: "shopify",
                shopDomain: target.shopDomain,
                metadata: shopifyShipmentRolloutMetadata(webhooks),
              }),
            ),
          ),
        );
      },
    });
    console.log(
      `[shopify-shipment-rollout] attempted=${summary.attempted} completed=${summary.completed} deferred=${summary.deferred.length} failed=${summary.failed.length}`,
    );
    for (const deferred of summary.deferred) {
      console.warn(
        `[shopify-shipment-rollout] tenant=${deferred.tenantId} shop=${deferred.shopDomain} deferred: reconnect Shopify to grant read_fulfillments`,
      );
    }
    for (const failure of summary.failed) {
      console.error(
        `[shopify-shipment-rollout] tenant=${failure.tenantId} shop=${failure.shopDomain} failed: ${failure.error}`,
      );
    }
    if (summary.failed.length > 0) {
      throw new Error(
        `Shopify shipment rollout failed for ${summary.failed.length} connector(s)`,
      );
    }
  } finally {
    await stopApprovalBoss();
    await runtime.dispose();
    await raw.close();
  }
};

main().catch((cause: unknown) => {
  console.error(
    `[shopify-shipment-rollout] fatal: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  );
  process.exitCode = 1;
});
