// ============================================================
// Shopify shop-policy import — pg-boss publisher (api side)
// ============================================================
//
// After a tenant's Shopify OAuth completes, the callback enqueues one job here
// so apps/worker can import the store's shipping + refund policies into the
// knowledge base off the request path. Same shape as the account-cleanup
// publisher: ensure the queue once per process, then `send`. Keeps boss.* off
// the service/runtime type surface (master-plan §16).
//
// Enqueue is BEST-EFFORT at the call site — policy import is a nice-to-have, so
// a publish failure is logged and swallowed rather than failing the connect.

// Keep this literal in sync with apps/worker's SHOPIFY_POLICY_IMPORT_QUEUE.
export const SHOPIFY_POLICY_IMPORT_QUEUE = "shopify.policies.import";

export interface ShopifyPolicyImportJobData {
  readonly tenantId: string;
}

/**
 * Minimal pg-boss surface this module needs — wide enough that callers can pass
 * a stub in tests without the full PgBoss type.
 */
export interface PolicyImportBossLike {
  readonly createQueue: (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly send: (name: string, data: any, options?: any) => Promise<unknown>;
}

export const makePgBossShopifyPolicyImportPublisher = (
  acquireBoss: () => Promise<PolicyImportBossLike>,
): ((data: ShopifyPolicyImportJobData) => Promise<string | null>) => {
  let ensured = false;
  return async (data: ShopifyPolicyImportJobData): Promise<string | null> => {
    const boss = await acquireBoss();
    if (!ensured) {
      // Keep options in sync with apps/worker's registerShopifyPolicyImport.
      // `standard` policy: at most one import per connect, and a duplicate is
      // harmless (the import dedups by policy URL + content hash).
      await boss.createQueue(SHOPIFY_POLICY_IMPORT_QUEUE, {
        policy: "standard",
        retryLimit: 2,
        retryBackoff: true,
      });
      ensured = true;
    }
    // singletonKey de-dupes truly-simultaneous identical sends; the import is
    // idempotent regardless.
    const id = await boss.send(SHOPIFY_POLICY_IMPORT_QUEUE, data, {
      singletonKey: data.tenantId,
    });
    return typeof id === "string" ? id : null;
  };
};
