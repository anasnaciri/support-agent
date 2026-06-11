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
 *
 * `outlook` (audit D8): Microsoft identity offers NO client-callable
 * token-revocation endpoint for the stored refresh token (Google's /revoke
 * has no analogue; `revokeSignInSessions` would nuke ALL of the user's
 * sessions across every app — wrong blast radius). The grant still flows
 * through `revokeConnectorGrant`, which encodes that limitation: it treats
 * the local wipe as authoritative and the Graph subscription lease
 * self-expires (~3 days), while the refresh token ages out on Microsoft's
 * side (~90 days of inactivity). See packages/providers oauth-revocation.ts.
 */
export interface EncryptedConnectorGrant {
  readonly provider: "shopify" | "gmail" | "google_sheets" | "outlook";
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
   * (single-tenant dev with no key configured) → if the job carries grants,
   * cleanup FAILS rather than silently leaving live provider grants
   * (re-audit #2). With no grants, `null` is fine.
   */
  readonly encryptionKey: Buffer | null;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Confirms the tenant's rows are DURABLY GONE before any destructive
   * external side-effect runs (re-audit #1 HIGH). The cleanup job is queued
   * before the DB wipe, so without this check a slow/failed wipe could let
   * the worker revoke grants + delete the WorkOS org + email while the tenant
   * still exists. The schedule supplies a DB-backed check; when omitted (unit
   * tests that don't exercise the gate) the check is skipped.
   */
  readonly confirmTenantDeleted?: (tenantId: string) => Promise<boolean>;
}

/** The wipe hasn't committed yet (or failed) — defer destructive cleanup. */
export class TenantNotYetDeletedError extends Error {
  readonly _tag = "TenantNotYetDeletedError";
  constructor(readonly tenantId: string) {
    super(
      `tenant ${tenantId} still present — wipe not committed; deferring cleanup`,
    );
  }
}

/** The job carries grants to revoke but no key is configured to decrypt them. */
export class MissingRevocationKeyError extends Error {
  readonly _tag = "MissingRevocationKeyError";
  constructor(readonly grantCount: number) {
    super(
      `cannot revoke ${grantCount} connector grant(s): CREDENTIAL_ENCRYPTION_KEY not configured on the worker`,
    );
  }
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
): Effect.Effect<void, ConnectorRevocationError | MissingRevocationKeyError> =>
  Effect.flatMap(
    Effect.gen(function* () {
      if (grants.length === 0) return [] as string[];
      const key = opts.encryptionKey;
      if (!key) {
        // The job carries grants but the worker can't decrypt them. FAIL
        // (re-audit #2) so pg-boss retries / dead-letters loudly — silently
        // succeeding would leave provider grants live forever.
        return yield* Effect.fail(new MissingRevocationKeyError(grants.length));
      }
      return yield* Effect.promise(async () => {
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
      });
    }),
    (failures) =>
      failures.length > 0
        ? Effect.fail(new ConnectorRevocationError(failures))
        : Effect.void,
  );

/**
 * GATE the cleanup until the tenant is durably deleted (re-audit #1). The job
 * is queued before the DB wipe, so a slow/failed wipe must NOT let us revoke
 * grants, delete the WorkOS org, or email while the tenant still exists. If
 * the tenant is still present we fail → pg-boss retries later; the wipe either
 * committed by then (proceed) or genuinely failed (the job eventually
 * dead-letters loudly, with nothing destructive done).
 */
const assertTenantDeleted = (
  data: AccountCleanupJobData,
  opts: AccountCleanupOptions,
): Effect.Effect<void, TenantNotYetDeletedError | Error> =>
  Effect.gen(function* () {
    if (!opts.confirmTenantDeleted) return;
    const gone = yield* Effect.tryPromise({
      try: () => opts.confirmTenantDeleted!(data.tenantId),
      catch: (cause) =>
        new Error(`account-cleanup tenant-deleted check failed: ${String(cause)}`),
    });
    if (!gone) {
      return yield* Effect.fail(new TenantNotYetDeletedError(data.tenantId));
    }
  });

/**
 * Confirm the tenant is durably deleted (gate), revoke provider grants, delete
 * the WorkOS org (if any), then send the deletion email — in that order. The
 * gate runs first so NO destructive external action happens before the wipe
 * commits (re-audit #1). Revocation FAILS the job (so pg-boss retries) if any
 * grant couldn't be revoked or the decryption key is missing (re-audit #2);
 * org delete is idempotent (404 = success); the email is the terminal step, so
 * a retry re-runs the idempotent steps and the email still sends at most once.
 */
export const runAccountCleanup = (
  data: AccountCleanupJobData,
  opts: AccountCleanupOptions = { encryptionKey: null },
): Effect.Effect<
  void,
  | OrgDirectoryError
  | PlatformMailError
  | ConnectorRevocationError
  | MissingRevocationKeyError
  | TenantNotYetDeletedError
  | Error,
  OrgDirectoryService | PlatformMailService
> =>
  Effect.gen(function* () {
    yield* assertTenantDeleted(data, opts);
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
