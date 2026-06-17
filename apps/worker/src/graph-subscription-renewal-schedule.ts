// ============================================================
// Graph subscription-renewal cron — pg-boss schedule + worker
// ============================================================
//
// Mirrors `gmail-watch-renewal-schedule.ts`. Lives at the wiring layer
// (apps/worker) because the cron call site is the only spot that touches
// pg-boss directly.

import { Effect } from "effect";
import {
  renewActiveGraphSubscriptions,
  type RenewActiveGraphSubscriptionsDeps,
  type GraphRenewalResult,
} from "./graph-subscription-renewal.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import { reportRenewalResultsHealth } from "./connector-health.js";

export const GRAPH_SUBSCRIPTION_RENEWAL_QUEUE = "graph.subscription-renewal";

/** Every 6 hours — 4 fires inside the 24h renewal margin. */
const RENEWAL_CRON = "0 */6 * * *";

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  readonly cron?: string;
}

/**
 * @returns `true` if registered, `false` when Microsoft OAuth + webhook env
 * vars are missing (the worker still runs for tenants without Outlook).
 */
export const registerGraphSubscriptionRenewal = async (
  opts: RegisterOptions,
): Promise<boolean> => {
  const clientId = process.env["MICROSOFT_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["MICROSOFT_OAUTH_CLIENT_SECRET"];
  const tenant = process.env["MICROSOFT_OAUTH_TENANT"]?.trim() || "common";
  const notificationUrl = process.env["MICROSOFT_GRAPH_NOTIFICATION_URL"]?.trim();
  const webhookClientState = process.env["MICROSOFT_GRAPH_WEBHOOK_SECRET"]?.trim();
  if (!clientId || !clientSecret || !notificationUrl || !webhookClientState) {
    return false;
  }
  const deps: RenewActiveGraphSubscriptionsDeps = {
    microsoft: { clientId, clientSecret, tenant, notificationUrl, webhookClientState },
  };

  await opts.boss.createQueue(GRAPH_SUBSCRIPTION_RENEWAL_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    GRAPH_SUBSCRIPTION_RENEWAL_QUEUE,
    opts.cron ?? RENEWAL_CRON,
    {},
    { tz: "UTC" },
  );

  await opts.boss.work<Record<string, never>, void>(
    GRAPH_SUBSCRIPTION_RENEWAL_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const results = await Effect.runPromise(
          Effect.provide(
            renewActiveGraphSubscriptions(deps),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ReadonlyArray<GraphRenewalResult>> => {
                // eslint-disable-next-line no-console
                console.error("[graph-subscription-renewal] pass crashed:", cause);
                return Effect.succeed([]);
              },
            ),
          ),
        );
        const renewed = results.filter(
          (r) => r.outcome === "renewed" || r.outcome === "created",
        ).length;
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
          `[graph-subscription-renewal] pass complete: renewed=${renewed} skipped=${skipped} failed=${failed.length}`,
        );
        for (const f of failed) {
          // eslint-disable-next-line no-console
          console.warn(
            `[graph-subscription-renewal] failed tenant=${f.tenantId} mailbox=${f.mailbox}: ${
              typeof f.outcome === "object" && "failed" in f.outcome
                ? f.outcome.failed
                : "?"
            }`,
          );
        }
        // Audit L5: stamp connector health + alert the operator once per
        // ok→broken transition. A lapsed Graph subscription is a hard
        // outage (no replayable cursor) — it must not stay invisible.
        await Effect.runPromise(
          Effect.provide(
            reportRenewalResultsHealth("outlook", results),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                // eslint-disable-next-line no-console
                console.error(
                  "[graph-subscription-renewal] health report crashed:",
                  cause,
                );
              }),
            ),
          ),
        );
      }
    },
  );
  return true;
};
