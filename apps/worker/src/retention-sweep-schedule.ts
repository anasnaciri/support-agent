// ============================================================
// Retention sweep cron — pg-boss schedule + worker
// ============================================================
//
// Wires `sweepAllTenants` onto pg-boss's `boss.schedule(...)` primitive.
// Same shape as `gmail-watch-renewal-schedule.ts` — keeps boss.* off
// the runtime / services / providers type surface (master-plan §16).

import { Effect } from "effect";
import { sweepAllTenants, type SweepResult } from "./retention-sweep.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const RETENTION_SWEEP_QUEUE = "retention.sweep";

/**
 * Cron expression: daily at 03:00 UTC. Off-peak for most regions; one
 * pass per day is enough — archiving/deletion windows are measured in days and
 * months, not hours. A missed run delays cleanup by up to 24h, which is well
 * inside any regulatory tolerance.
 */
const SWEEP_CRON = "0 3 * * *";

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Override the cron expression — primarily for tests. */
  readonly cron?: string;
}

export const registerRetentionSweep = async (
  opts: RegisterOptions,
): Promise<void> => {
  await opts.boss.createQueue(RETENTION_SWEEP_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  // pg-boss `schedule` is idempotent on (name, cron) — safe to call
  // every boot; duplicate calls update the schedule in place.
  await opts.boss.schedule(
    RETENTION_SWEEP_QUEUE,
    opts.cron ?? SWEEP_CRON,
    {},
    { tz: "UTC" },
  );

  await opts.boss.work<Record<string, never>, void>(
    RETENTION_SWEEP_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const results = await Effect.runPromise(
          Effect.provide(sweepAllTenants(), opts.runtimeLayer).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ReadonlyArray<SweepResult>> => {
                // eslint-disable-next-line no-console
                console.error("[retention-sweep] pass crashed:", cause);
                return Effect.succeed([]);
              },
            ),
          ),
        );

        let totalArchived = 0;
        let totalDeletedCases = 0;
        let totalAudit = 0;
        let totalApprovals = 0;
        let okCount = 0;
        const failures: Array<{ tenantId: string; error: string }> = [];
        for (const r of results) {
          if (r.kind === "ok") {
            okCount += 1;
            totalArchived += r.archivedCases;
            totalDeletedCases += r.deletedCases;
            totalAudit += r.deletedAuditRows;
            totalApprovals += r.deletedApprovals;
          } else {
            failures.push({ tenantId: r.tenantId, error: r.error });
          }
        }
        // eslint-disable-next-line no-console
        console.log(
          `[retention-sweep] pass complete: tenants=${okCount} archived=${totalArchived} deleted_cases=${totalDeletedCases} audit=${totalAudit} approvals=${totalApprovals} failed_tenants=${failures.length}`,
        );
        for (const f of failures) {
          // eslint-disable-next-line no-console
          console.warn(
            `[retention-sweep] tenant=${f.tenantId} failed: ${f.error}`,
          );
        }
      }
    },
  );
};
