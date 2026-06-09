// ============================================================
// Shopify shop-policy import consumer — pg-boss worker
// ============================================================
//
// Drains the `shopify.policies.import` queue that apps/api publishes to after a
// tenant's Shopify OAuth completes. Same shape as `account-cleanup-schedule.ts`
// (a plain work queue, not a cron). The actual import is best-effort: the
// handler runs `runShopifyPolicyImport`, which logs + swallows every error, so
// a store with no policies / a missing scope / a flaky API can never wedge the
// queue or surface as a job failure.

import { Effect } from "effect";
import { TenantId } from "@support-agent/agent-core";
import { runShopifyPolicyImport } from "./shopify-policy-import.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

// Keep this literal in sync with apps/api's SHOPIFY_POLICY_IMPORT_QUEUE.
export const SHOPIFY_POLICY_IMPORT_QUEUE = "shopify.policies.import";

interface ShopifyPolicyImportJobData {
  readonly tenantId: string;
}

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
}

export const registerShopifyPolicyImport = async (
  opts: RegisterOptions,
): Promise<void> => {
  // Keep options in sync with apps/api's makePgBossShopifyPolicyImportPublisher.
  await opts.boss.createQueue(SHOPIFY_POLICY_IMPORT_QUEUE, {
    policy: "standard",
    retryLimit: 2,
    retryBackoff: true,
  });

  await opts.boss.work<ShopifyPolicyImportJobData, void>(
    SHOPIFY_POLICY_IMPORT_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        await Effect.runPromise(
          Effect.provide(
            runShopifyPolicyImport(TenantId(job.data.tenantId)),
            opts.runtimeLayer,
          ),
        );
      }
    },
  );
};
