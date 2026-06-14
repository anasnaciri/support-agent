import { PgBoss } from "pg-boss";
import {
  makePgBossAccountCleanupPublisher,
  type AccountCleanupJobData,
} from "../account-deletion.js";
import {
  makePgBossShopifyPolicyImportPublisher,
  type ShopifyPolicyImportJobData,
} from "../shopify-policy-import-queue.js";

// ============================================================
// Shared pg-boss singleton + job publishers
// ============================================================
//
// One lazily-started pg-boss instance backs the approval/workflow queue, the
// account-cleanup job, and the post-connect Shopify policy import. It is
// memoized for the lifetime of the process and stopped on server shutdown via
// `stopApprovalBoss()`.

let cachedApprovalBoss: PgBoss | null = null;
export const acquireApprovalBoss = async (
  databaseUrl: string,
): Promise<PgBoss> => {
  if (cachedApprovalBoss) return cachedApprovalBoss;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue("workflow.events", {
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryBackoff: true,
  });
  cachedApprovalBoss = boss;
  return boss;
};

/**
 * Stop the shared approval pg-boss (started lazily on the first approval
 * decision) so shutdown / tests don't leak its connection, and drop the
 * memoized publishers so a fresh server re-ensures the queue against a new
 * pg-boss instance. Called from the server's `close()`.
 */
export const stopApprovalBoss = async (): Promise<void> => {
  if (cachedApprovalBoss) {
    await cachedApprovalBoss.stop();
    cachedApprovalBoss = null;
  }
  cachedCleanupPublisher = null;
  cachedPolicyImportPublisher = null;
};

// Lazily-built, process-memoized publisher for the account-cleanup job
// (WorkOS org delete + deletion email). Reuses the shared pg-boss instance.
let cachedCleanupPublisher:
  | ((data: AccountCleanupJobData) => Promise<string | null>)
  | null = null;
export const accountCleanupPublisher = (
  databaseUrl: string,
): ((data: AccountCleanupJobData) => Promise<string | null>) => {
  if (!cachedCleanupPublisher) {
    cachedCleanupPublisher = makePgBossAccountCleanupPublisher(() =>
      acquireApprovalBoss(databaseUrl),
    );
  }
  return cachedCleanupPublisher;
};

// Lazily-built, process-memoized publisher for the post-connect Shopify policy
// import. Reuses the shared pg-boss instance (same as the approval + cleanup
// publishers).
let cachedPolicyImportPublisher:
  | ((data: ShopifyPolicyImportJobData) => Promise<string | null>)
  | null = null;
export const shopifyPolicyImportPublisher = (
  databaseUrl: string,
): ((data: ShopifyPolicyImportJobData) => Promise<string | null>) => {
  if (!cachedPolicyImportPublisher) {
    cachedPolicyImportPublisher = makePgBossShopifyPolicyImportPublisher(() =>
      acquireApprovalBoss(databaseUrl),
    );
  }
  return cachedPolicyImportPublisher;
};
