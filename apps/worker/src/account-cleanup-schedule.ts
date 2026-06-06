// ============================================================
// Account cleanup consumer — pg-boss worker
// ============================================================
//
// Drains the `account.cleanup` queue that apps/api publishes to after a
// tenant wipe. Same shape as `retention-sweep-schedule.ts`, but a plain
// work queue (not a cron schedule). Keeps boss.* off the runtime / service
// type surface (master-plan §16).

import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { DbClient, tenants } from "@support-agent/db";
import {
  runAccountCleanup,
  type AccountCleanupJobData,
} from "./account-cleanup.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

// Keep this literal in sync with apps/api's ACCOUNT_CLEANUP_QUEUE.
export const ACCOUNT_CLEANUP_QUEUE = "account.cleanup";

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Shared key to decrypt connector-grant tokens for revocation (B1). */
  readonly encryptionKey: Buffer | null;
}

export const registerAccountCleanup = async (
  opts: RegisterOptions,
): Promise<void> => {
  // Options kept in sync with apps/api's makePgBossAccountCleanupPublisher.
  await opts.boss.createQueue(ACCOUNT_CLEANUP_QUEUE, {
    policy: "standard",
    retryLimit: 5,
    retryBackoff: true,
  });

  // The durable deletion gate (re-audit #1): the worker only runs destructive
  // cleanup once the tenant's rows are actually gone. The job is enqueued
  // BEFORE the wipe, so this check — not a timing delay — is what makes
  // cleanup safe against a slow or failed wipe.
  const confirmTenantDeleted = (tenantId: string): Promise<boolean> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* DbClient;
          const rows = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ id: tenants.id })
                .from(tenants)
                .where(eq(tenants.id, tenantId))
                .limit(1),
            catch: (cause) =>
              new Error(`tenant existence check failed: ${String(cause)}`),
          });
          return rows.length === 0;
        }),
        opts.runtimeLayer,
      ),
    );

  await opts.boss.work<AccountCleanupJobData, void>(
    ACCOUNT_CLEANUP_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        const data = job.data;
        // Let failures throw so pg-boss applies its retry policy. The gate +
        // idempotent org delete make a retry after a partial failure safe.
        await Effect.runPromise(
          Effect.provide(
            runAccountCleanup(data, {
              encryptionKey: opts.encryptionKey,
              confirmTenantDeleted,
            }),
            opts.runtimeLayer,
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `[account-cleanup] tenant=${data.tenantId} org=${
            data.workosOrganizationId ?? "(none)"
          } emailed=${data.notificationEmail ? "yes" : "no"}`,
        );
      }
    },
  );
};
