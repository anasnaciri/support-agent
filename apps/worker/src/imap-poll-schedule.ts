// ============================================================
// IMAP inbound poll cron — pg-boss schedule + worker
// ============================================================
//
// Mirrors the renewal-cron wiring. Polling (not IDLE) was the chosen inbound
// strategy for generic IMAP, so this fires often and walks every active
// mailbox. Gated on CREDENTIAL_ENCRYPTION_KEY — without it the store can't
// decrypt the stored app passwords.

import { Effect } from "effect";
import {
  pollActiveImapMailboxes,
  type ImapPollResult,
} from "./imap-poll.js";
import { enqueueWorkflowEvent } from "./workflow-queue-live.js";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import { reportRenewalResultsHealth } from "./connector-health.js";

export const IMAP_POLL_QUEUE = "imap.poll";

/** Every minute — IMAP has no push, so latency is the poll interval. */
const POLL_CRON = "* * * * *";

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  readonly cron?: string;
}

/**
 * @returns `true` if registered, `false` when CREDENTIAL_ENCRYPTION_KEY is
 * absent (no generic-mailbox decryption possible — the worker still runs).
 */
export const registerImapPoll = async (
  opts: RegisterOptions,
): Promise<boolean> => {
  if (!process.env["CREDENTIAL_ENCRYPTION_KEY"]) return false;

  const publish = (event: Parameters<typeof enqueueWorkflowEvent>[1]) =>
    Effect.runPromise(
      enqueueWorkflowEvent(opts.boss, event).pipe(Effect.map(() => undefined as void)),
    );

  await opts.boss.createQueue(IMAP_POLL_QUEUE, {
    policy: "singleton",
    retryLimit: 1,
  });
  await opts.boss.schedule(IMAP_POLL_QUEUE, opts.cron ?? POLL_CRON, {}, { tz: "UTC" });

  await opts.boss.work<Record<string, never>, void>(
    IMAP_POLL_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const results = await Effect.runPromise(
          Effect.provide(
            pollActiveImapMailboxes({ publish }),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ReadonlyArray<ImapPollResult>> => {
                // eslint-disable-next-line no-console
                console.error("[imap-poll] pass crashed:", cause);
                return Effect.succeed([]);
              },
            ),
          ),
        );
        const published = results.reduce(
          (n, r) =>
            typeof r.outcome === "object" && "polled" in r.outcome
              ? n + r.outcome.polled
              : n,
          0,
        );
        const failed = results.filter(
          (r) => typeof r.outcome === "object" && "failed" in r.outcome,
        );
        if (published > 0 || failed.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[imap-poll] pass complete: published=${published} mailboxes=${results.length} failed=${failed.length}`,
          );
        }
        for (const f of failed) {
          // eslint-disable-next-line no-console
          console.warn(
            `[imap-poll] failed tenant=${f.tenantId} mailbox=${f.mailbox}: ${
              typeof f.outcome === "object" && "failed" in f.outcome
                ? f.outcome.failed
                : "?"
            }`,
          );
        }
        // Audit L5: connector health flag + one-time operator alert.
        await Effect.runPromise(
          Effect.provide(
            reportRenewalResultsHealth("imap", results),
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                // eslint-disable-next-line no-console
                console.error("[imap-poll] health report crashed:", cause);
              }),
            ),
          ),
        );
      }
    },
  );
  return true;
};
