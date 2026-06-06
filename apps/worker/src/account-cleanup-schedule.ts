// ============================================================
// Account cleanup consumer — pg-boss worker
// ============================================================
//
// Drains the `account.cleanup` queue that apps/api publishes to after a
// tenant wipe. Same shape as `retention-sweep-schedule.ts`, but a plain
// work queue (not a cron schedule). Keeps boss.* off the runtime / service
// type surface (master-plan §16).

import { Effect } from "effect";
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

  await opts.boss.work<AccountCleanupJobData, void>(
    ACCOUNT_CLEANUP_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        const data = job.data;
        // Let failures throw so pg-boss applies its retry policy. The org
        // delete is idempotent, so a retry after a partial failure (e.g.
        // email send) is safe.
        await Effect.runPromise(
          Effect.provide(
            runAccountCleanup(data, { encryptionKey: opts.encryptionKey }),
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
