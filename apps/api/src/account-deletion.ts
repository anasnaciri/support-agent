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

/** Providers whose connection IS a revocable OAuth grant. LLM BYOK keys
 * (openrouter/anthropic/openai) and outlook (not yet wired) are excluded. */
export const REVOCABLE_GRANT_PROVIDERS: ReadonlyArray<
  EncryptedConnectorGrant["provider"]
> = ["shopify", "gmail", "google_sheets"];

/** A connector row, narrowed to the fields grant-capture needs. */
export interface ConnectorGrantSource {
  readonly provider: string;
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly apiVersion: string | null;
  /** Local status — intentionally NOT filtered on (re-audit #1a). */
  readonly status: string;
}

/**
 * Build the encrypted grant list for the cleanup job from a tenant's connector
 * rows. Keeps EVERY revocable-provider row regardless of local `status`
 * (re-audit #1a): a row we marked `revoked`/disconnected locally may still
 * have a LIVE grant on the provider that must be revoked. `encryptToB64`
 * encrypts each token so plaintext never lands in the pg-boss job table.
 */
export const buildConnectorGrants = (
  rows: ReadonlyArray<ConnectorGrantSource>,
  encryptToB64: (plaintext: string) => string,
): ReadonlyArray<EncryptedConnectorGrant> =>
  rows
    .filter((c) =>
      (REVOCABLE_GRANT_PROVIDERS as ReadonlyArray<string>).includes(c.provider),
    )
    .map((c) => ({
      provider: c.provider as EncryptedConnectorGrant["provider"],
      shopDomain: c.shopDomain,
      accessTokenEncrypted: encryptToB64(c.accessToken),
      refreshTokenEncrypted: c.refreshToken ? encryptToB64(c.refreshToken) : null,
      apiVersion: c.apiVersion,
    }));

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
 *
 * The api enqueues this BEFORE wiping the tenant (so an enqueue failure can't
 * orphan a wiped tenant — re-audit #1c). Safety against a slow/failed wipe is
 * the worker's DURABLE deletion gate (it refuses destructive cleanup until the
 * tenant rows are actually gone — see apps/worker account-cleanup), NOT this
 * delay: `startAfter` is only an optimization that avoids a near-certain
 * first-attempt retry in the normal case. The singleton key collapses a retry
 * of the same deletion onto the one job.
 */
const CLEANUP_START_AFTER_SECONDS = 30;

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
      startAfter: CLEANUP_START_AFTER_SECONDS,
    });
  };
};
