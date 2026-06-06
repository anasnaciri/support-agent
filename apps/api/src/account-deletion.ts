// ============================================================
// Account deletion — cleanup job publisher
// ============================================================
//
// Tenant self-service deletion (and the admin "delete any account" path)
// runs in two parts:
//   1. apps/api wipes every tenant row synchronously (redactShop) inside
//      the request, after capturing the WorkOS org + notification email.
//   2. The external side-effects — deleting the WorkOS organization and
//      emailing a deletion confirmation — are handed to apps/worker via
//      this pg-boss job, so they get pg-boss's retry semantics instead of
//      best-effort-in-a-request-handler. See `apps/worker`'s
//      account-cleanup consumer.
//
// The job payload carries everything the worker needs BECAUSE the tenant
// row is already gone by the time it runs — nothing can be re-read.

// Keep this literal in sync with apps/worker's ACCOUNT_CLEANUP_QUEUE.
export const ACCOUNT_CLEANUP_QUEUE = "account.cleanup";

export interface AccountCleanupJobData {
  readonly tenantId: string;
  readonly tenantName: string;
  /** null → headless / Shopify-only tenant; the worker skips the IdP step. */
  readonly workosOrganizationId: string | null;
  /** null → no email configured; the worker skips the mail step. */
  readonly notificationEmail: string | null;
  /**
   * Provider-side OAuth grants captured BEFORE the wipe (the connector rows
   * are gone by cleanup time, so they can't be re-read). The worker revokes
   * each best-effort (audit B1). Absent on jobs enqueued before this field
   * existed → the worker treats it as an empty list.
   *
   * Tokens are AES-GCM ciphertext (base64) under the shared
   * CREDENTIAL_ENCRYPTION_KEY — never plaintext in the pg-boss job table,
   * preserving the at-rest protection the connector store gives them. Only
   * OAuth-grant providers are included; LLM BYOK keys have nothing to revoke.
   */
  readonly connectorGrants?: ReadonlyArray<EncryptedConnectorGrant>;
}

export interface EncryptedConnectorGrant {
  readonly provider: "shopify" | "gmail" | "google_sheets";
  readonly shopDomain: string;
  readonly accessTokenEncrypted: string;
  readonly refreshTokenEncrypted: string | null;
  readonly apiVersion: string | null;
}

/**
 * Minimal pg-boss surface this module needs. Wider than the real `PgBoss`
 * type so callers can pass stubs in tests without the whole type surface.
 */
export interface CleanupBossLike {
  readonly createQueue: (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly send: (name: string, data: any, options?: any) => Promise<unknown>;
}

/**
 * Build the cleanup publisher. Ensures the queue exists once per process
 * (the worker also creates it on boot, but the api may publish before the
 * worker has — pg-boss requires the queue to exist before `send`). Uses
 * the tenant id as the singleton key so a double-submit collapses to one
 * cleanup job.
 */
export const makePgBossAccountCleanupPublisher = (
  acquireBoss: () => Promise<CleanupBossLike>,
): ((data: AccountCleanupJobData) => Promise<void>) => {
  let ensured = false;
  return async (data: AccountCleanupJobData): Promise<void> => {
    const boss = await acquireBoss();
    if (!ensured) {
      // Keep options in sync with apps/worker's registerAccountCleanup.
      await boss.createQueue(ACCOUNT_CLEANUP_QUEUE, {
        policy: "standard",
        retryLimit: 5,
        retryBackoff: true,
      });
      ensured = true;
    }
    await boss.send(ACCOUNT_CLEANUP_QUEUE, data, {
      singletonKey: data.tenantId,
    });
  };
};
