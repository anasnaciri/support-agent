// ============================================================
// Gmail watch-renewal cron — pg-boss schedule + worker
// ============================================================
//
// Wires `renewActiveGmailWatches` onto pg-boss's `boss.schedule(...)`
// primitive. Lives at the wiring layer (apps/worker) rather than in
// services/providers because the cron call site is the only spot that
// knows about pg-boss directly — keeps `boss.*` references off the type
// surface of the runtime and tools (master-plan §16).

import { Effect } from "effect";
import {
  renewActiveGmailWatches,
  type RenewActiveGmailWatchesDeps,
  type RenewalResult,
} from "./gmail-watch-renewal.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";

export const GMAIL_WATCH_RENEWAL_QUEUE = "gmail.watch-renewal";

/**
 * Cron expression: every 6 hours. Renewal trigger is "≤24h until expiry",
 * so 4 fires inside the safety margin = a single missed run doesn't lose
 * the lease.
 */
const RENEWAL_CRON = "0 */6 * * *";

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Override the cron expression — primarily for tests. */
  readonly cron?: string;
}

/**
 * @returns `true` if the schedule was registered, `false` when Google
 * OAuth env vars are missing (we silently skip — the worker still runs
 * for tenants without Gmail).
 */
export const registerGmailWatchRenewal = async (
  opts: RegisterOptions,
): Promise<boolean> => {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const pubsubTopic = process.env["GMAIL_PUBSUB_TOPIC"];
  if (!clientId || !clientSecret || !pubsubTopic) {
    return false;
  }
  const deps: RenewActiveGmailWatchesDeps = {
    google: { clientId, clientSecret, pubsubTopic },
  };

  // pg-boss `schedule` is idempotent on (name, cron). We're safe to call
  // it on every boot — duplicate calls update the schedule in place.
  await opts.boss.createQueue(GMAIL_WATCH_RENEWAL_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    GMAIL_WATCH_RENEWAL_QUEUE,
    opts.cron ?? RENEWAL_CRON,
    {},
    { tz: "UTC" },
  );

  // Worker side: when the schedule fires (or a manual `boss.send` to this
  // queue lands), run the renewal pass and log the per-mailbox outcomes.
  await opts.boss.work<Record<string, never>, void>(
    GMAIL_WATCH_RENEWAL_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const results = await Effect.runPromise(
          Effect.provide(
            renewActiveGmailWatches(deps) as Effect.Effect<
              ReadonlyArray<RenewalResult>,
              unknown,
              never
            >,
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ReadonlyArray<RenewalResult>> => {
                // eslint-disable-next-line no-console
                console.error(
                  "[gmail-watch-renewal] pass crashed:",
                  cause,
                );
                return Effect.succeed([]);
              },
            ),
          ),
        );
        const renewed = results.filter((r) => r.outcome === "renewed").length;
        const skipped = results.filter(
          (r) =>
            r.outcome === "skipped_not_due" ||
            r.outcome === "skipped_no_refresh_token",
        ).length;
        const failed = results.filter(
          (r) => typeof r.outcome === "object" && "failed" in r.outcome,
        );
        // eslint-disable-next-line no-console
        console.log(
          `[gmail-watch-renewal] pass complete: renewed=${renewed} skipped=${skipped} failed=${failed.length}`,
        );
        if (failed.length > 0) {
          for (const f of failed) {
            // eslint-disable-next-line no-console
            console.warn(
              `[gmail-watch-renewal] failed tenant=${f.tenantId} mailbox=${f.mailbox}: ${
                typeof f.outcome === "object" && "failed" in f.outcome
                  ? f.outcome.failed
                  : "?"
              }`,
            );
          }
        }
      }
    },
  );
  return true;
};
