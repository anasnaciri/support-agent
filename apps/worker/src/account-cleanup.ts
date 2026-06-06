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

/** A grant whose revocation did not succeed and is not "already gone". */
export class ConnectorRevocationError extends Error {
  readonly _tag = "ConnectorRevocationError";
  constructor(readonly failures: ReadonlyArray<string>) {
    super(`connector revocation failed for: ${failures.join(", ")}`);
  }
}

/**
 * Revoke each provider grant — decrypt the tokens, call the provider revoke
 * endpoint. Every grant is attempted (one bad grant doesn't stop the others),
 * then if ANY genuinely failed (transient/unknown — `already_gone` and
 * `revoked` are successes) the Effect FAILS so pg-boss retries the job. This
 * runs FIRST, before the (idempotent) org delete and the (terminal) email, so
 * a retry re-runs revocation idempotently and the email still sends at most
 * once. A missing encryption key (single-tenant dev) skips revocation with a
 * warning rather than failing.
 */
const revokeConnectorGrants = (
  grants: ReadonlyArray<EncryptedConnectorGrant>,
  opts: AccountCleanupOptions,
): Effect.Effect<void, ConnectorRevocationError> =>
  Effect.flatMap(
    Effect.promise(async () => {
      if (grants.length === 0) return [] as string[];
      const key = opts.encryptionKey;
      if (!key) {
        // eslint-disable-next-line no-console
        console.warn(
          `[account-cleanup] ${grants.length} connector grant(s) not revoked: no CREDENTIAL_ENCRYPTION_KEY configured`,
        );
        return [] as string[];
      }
      const dec = (b64: string): string =>
        decryptToString(key, Buffer.from(b64, "base64"));
      const failures: Array<string> = [];
      for (const g of grants) {
        const label = `${g.provider}/${g.shopDomain}`;
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
              `[account-cleanup] revoke ${label} failed: ${outcome.detail}`,
            );
            failures.push(label);
          }
        } catch (cause) {
          // eslint-disable-next-line no-console
          console.error(`[account-cleanup] revoke ${label} threw:`, cause);
          failures.push(label);
        }
      }
      return failures;
    }),
    (failures) =>
      failures.length > 0
        ? Effect.fail(new ConnectorRevocationError(failures))
        : Effect.void,
  );

/**
 * Revoke provider grants, delete the WorkOS org (if any), then send the
 * deletion email (if a recipient was captured) — in that order. Revocation
 * runs first and FAILS the job (so pg-boss retries) if any grant couldn't be
 * revoked; org delete is idempotent (the Live impl treats a 404 as success);
 * the email is the terminal step, so a retry re-runs the idempotent steps and
 * the email still sends at most once. Any failure propagates so pg-boss
 * retries the whole job.
 */
export const runAccountCleanup = (
  data: AccountCleanupJobData,
  opts: AccountCleanupOptions = { encryptionKey: null },
): Effect.Effect<
  void,
  OrgDirectoryError | PlatformMailError | ConnectorRevocationError,
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
