// ============================================================
// OpenRouter credits-low cron — pg-boss schedule + worker
// ============================================================
//
// Wires `checkOpenRouterCredits` onto `boss.schedule(...)`, mirroring
// the other connector crons. Always registered: with no active
// openrouter keys the pass is a cheap no-op, and the threshold is a
// deploy-level knob (LLM_CREDITS_ALERT_THRESHOLD_USD, default $5).

import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import { DbClient, connectorConnections } from "@support-agent/db";
import type { ConnectorCredentialStore } from "@support-agent/services";
import type { PgBoss } from "./queue.js";
import type { WorkerBootstrap } from "./bootstrap.js";
import {
  checkOpenRouterCredits,
  type LlmCreditsResult,
  type LlmCreditsTarget,
} from "./llm-credits.js";

export const LLM_CREDITS_QUEUE = "llm.credits-check";

/** Every 6 hours, offset from the renewal crons' minute-0 firings. */
const CREDITS_CRON = "30 */6 * * *";

export const DEFAULT_CREDITS_THRESHOLD_USD = 5;

/** Parse the env threshold, falling back to the default on nonsense. */
export const creditsThresholdFromEnv = (
  raw: string | undefined,
): number => {
  if (!raw) return DEFAULT_CREDITS_THRESHOLD_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CREDITS_THRESHOLD_USD;
};

/** Active openrouter key rows — the targets of one credits pass. */
export const listOpenRouterTargets: Effect.Effect<
  ReadonlyArray<LlmCreditsTarget>,
  unknown,
  DbClient
> = Effect.gen(function* () {
  const db = yield* DbClient;
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          tenantId: connectorConnections.tenantId,
          shopDomain: connectorConnections.shopDomain,
        })
        .from(connectorConnections)
        .where(
          and(
            eq(connectorConnections.provider, "openrouter"),
            eq(connectorConnections.status, "active"),
          ),
        ),
    catch: (cause) => new Error(`llm-credits select: ${String(cause)}`),
  });
  return rows;
});

interface RegisterOptions {
  readonly boss: PgBoss;
  readonly runtimeLayer: WorkerBootstrap["runtimeLayer"];
  /** Override the cron expression — primarily for tests. */
  readonly cron?: string;
}

export const registerLlmCreditsCheck = async (
  opts: RegisterOptions,
): Promise<void> => {
  const thresholdUsd = creditsThresholdFromEnv(
    process.env["LLM_CREDITS_ALERT_THRESHOLD_USD"],
  );

  await opts.boss.createQueue(LLM_CREDITS_QUEUE, {
    policy: "singleton",
    retryLimit: 2,
    retryBackoff: true,
  });
  await opts.boss.schedule(
    LLM_CREDITS_QUEUE,
    opts.cron ?? CREDITS_CRON,
    {},
    { tz: "UTC" },
  );

  await opts.boss.work<Record<string, never>, void>(
    LLM_CREDITS_QUEUE,
    async (jobs) => {
      for (const _job of jobs) {
        const results = await Effect.runPromise(
          Effect.provide(
            // R narrowed to never at the call site — the worker's
            // runtimeLayer provides DbClient + ConnectorCredentialStore
            // (same pattern as the renewal crons).
            Effect.flatMap(listOpenRouterTargets, (targets) =>
              checkOpenRouterCredits(targets, { thresholdUsd }),
            ) as unknown as Effect.Effect<
              ReadonlyArray<LlmCreditsResult>,
              unknown,
              never
            >,
            opts.runtimeLayer,
          ).pipe(
            Effect.catchAllCause(
              (cause): Effect.Effect<ReadonlyArray<LlmCreditsResult>> => {
                // eslint-disable-next-line no-console
                console.error("[llm-credits] pass crashed:", cause);
                return Effect.succeed([]);
              },
            ),
          ),
        );
        const alerted = results.filter((r) => r.outcome === "alerted").length;
        const failed = results.filter(
          (r) => typeof r.outcome === "object",
        ).length;
        // eslint-disable-next-line no-console
        console.log(
          `[llm-credits] pass complete: checked=${results.length} alerted=${alerted} failed=${failed}`,
        );
      }
    },
  );
};
