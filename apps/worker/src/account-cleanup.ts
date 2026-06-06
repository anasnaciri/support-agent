// ============================================================
// Account cleanup — external side-effects after a tenant wipe
// ============================================================
//
// apps/api wipes every tenant row synchronously, then enqueues this job.
// The worker performs the two external side-effects that the api edge
// can't (it has neither WorkOS nor Resend wired): deleting the tenant's
// WorkOS organization and emailing a deletion confirmation. Running here
// means both get pg-boss retry semantics.
//
// The job payload carries everything BECAUSE the tenant row is already
// gone — nothing can be re-read. Mirrors apps/api's AccountCleanupJobData.

import { Effect } from "effect";
import { TenantId } from "@support-agent/agent-core";
import {
  decryptToString,
  OrgDirectoryService,
  PlatformMailService,
  type OrgDirectoryError,
  type PlatformMailError,
} from "@support-agent/services";
import { revokeConnectorGrant } from "@support-agent/providers";

/**
 * A connector grant to revoke provider-side (audit B1). Tokens are AES-GCM
 * ciphertext (base64) under the shared CREDENTIAL_ENCRYPTION_KEY — the api
 * encrypted them before the wipe so they never sit in the pg-boss table in
 * plaintext. Mirrors apps/api's EncryptedConnectorGrant.
 */
export interface EncryptedConnectorGrant {
  readonly provider: "shopify" | "gmail" | "google_sheets";
  readonly shopDomain: string;
  readonly accessTokenEncrypted: string;
  readonly refreshTokenEncrypted: string | null;
  readonly apiVersion: string | null;
}

export interface AccountCleanupJobData {
  readonly tenantId: string;
  readonly tenantName: string;
  /** null → headless / Shopify-only tenant; skip the WorkOS step. */
  readonly workosOrganizationId: string | null;
  /** null → no email configured; skip the mail step. */
  readonly notificationEmail: string | null;
  /** Provider OAuth grants to revoke; absent on legacy jobs. */
  readonly connectorGrants?: ReadonlyArray<EncryptedConnectorGrant>;
}

export interface AccountCleanupOptions {
  /**
   * Shared CREDENTIAL_ENCRYPTION_KEY used to decrypt grant tokens. `null`
   * (single-tenant dev with no key configured) → grant revocation is
   * skipped with a log line; the WorkOS + email steps still run.
   */
  readonly encryptionKey: Buffer | null;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Revoke each provider grant BEST-EFFORT — decrypt the tokens, call the
 * provider revoke endpoint, log the outcome. Never fails the Effect: a
 * third-party API being down must not block the WorkOS org delete + email,
 * and (because revocation runs first) must not trigger a pg-boss retry that
 * would re-send the non-idempotent deletion email.
 */
const revokeConnectorGrants = (
  grants: ReadonlyArray<EncryptedConnectorGrant>,
  opts: AccountCleanupOptions,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (grants.length === 0) return;
    const key = opts.encryptionKey;
    if (!key) {
      // eslint-disable-next-line no-console
      console.warn(
        `[account-cleanup] ${grants.length} connector grant(s) not revoked: no CREDENTIAL_ENCRYPTION_KEY configured`,
      );
      return;
    }
    const dec = (b64: string): string =>
      decryptToString(key, Buffer.from(b64, "base64"));
    for (const g of grants) {
      try {
        const outcome = await revokeConnectorGrant(
          {
            provider: g.provider,
            shopDomain: g.shopDomain,
            accessToken: dec(g.accessTokenEncrypted),
            refreshToken: g.refreshTokenEncrypted
              ? dec(g.refreshTokenEncrypted)
              : null,
            apiVersion: g.apiVersion,
          },
          opts.fetchImpl,
        );
        if (outcome.kind === "failed") {
          // eslint-disable-next-line no-console
          console.error(
            `[account-cleanup] revoke ${g.provider}/${g.shopDomain} failed: ${outcome.detail}`,
          );
        }
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.error(
          `[account-cleanup] revoke ${g.provider}/${g.shopDomain} threw:`,
          cause,
        );
      }
    }
  });

/**
 * Revoke provider grants (best-effort), delete the WorkOS org (if any),
 * then send the deletion email (if a recipient was captured). Revocation is
 * first and non-failing; org delete is idempotent (the Live impl treats a
 * 404 as success), so a pg-boss retry after a failed email re-runs cleanly
 * and the email still sends exactly once. Any WorkOS/email failure
 * propagates so pg-boss retries the job.
 */
export const runAccountCleanup = (
  data: AccountCleanupJobData,
  opts: AccountCleanupOptions = { encryptionKey: null },
): Effect.Effect<
  void,
  OrgDirectoryError | PlatformMailError,
  OrgDirectoryService | PlatformMailService
> =>
  Effect.gen(function* () {
    yield* revokeConnectorGrants(data.connectorGrants ?? [], opts);
    if (data.workosOrganizationId) {
      const dir = yield* OrgDirectoryService;
      yield* dir.deleteOrganization(data.workosOrganizationId);
    }
    if (data.notificationEmail) {
      const mail = yield* PlatformMailService;
      yield* mail.sendAccountDeleted({
        tenantId: TenantId(data.tenantId),
        tenantName: data.tenantName,
        recipientEmail: data.notificationEmail,
      });
    }
  });
