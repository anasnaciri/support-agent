import { Effect, Layer } from "effect";
import { TransactionRunner } from "@support-agent/services";
import type postgres from "postgres";
import { DbClient, withTransaction } from "./db-client.js";

/**
 * Live implementation: every `run(eff)` opens a Drizzle transaction, swaps
 * the `CurrentTxRef` FiberRef so every repository call inside `eff` uses the
 * tx, and rolls back on Effect failure.
 *
 * `withLock(key, eff)` (audit L2) reserves a dedicated connection from the
 * postgres-js pool and holds `pg_advisory_lock(hashtext(key))` for the
 * duration of `eff` — a SESSION lock on a pinned connection, so it spans
 * the whole effect (multiple transactions included) and serializes across
 * worker replicas. Release runs on success, failure, and interruption.
 *
 * Note: the closure captures `DbClient` at Layer construction so the Tag's
 * `run` signature stays free of DbClient in R. Callers depend only on
 * `TransactionRunner`.
 */
export const TransactionRunnerLive = Layer.effect(
  TransactionRunner,
  Effect.gen(function* () {
    // Capture DbClient at Layer build time so the Tag's `run` signature
    // (which is R-polymorphic and does NOT include DbClient in R) is
    // satisfiable: `withTransaction` needs DbClient, but we provide it
    // inline from the captured value.
    const db = yield* DbClient;
    // drizzle/postgres-js exposes the underlying postgres-js client.
    const sql = (db as unknown as { $client: postgres.Sql }).$client;

    type Reserved = postgres.Sql & { release: () => void };

    const acquireLock = (key: string): Effect.Effect<Reserved> =>
      Effect.promise(async () => {
        const reserved = (await sql.reserve()) as unknown as Reserved;
        try {
          await reserved`SELECT pg_advisory_lock(hashtext(${key}))`;
        } catch (cause) {
          reserved.release();
          throw cause;
        }
        return reserved;
      });

    const releaseLock = (key: string, reserved: Reserved): Effect.Effect<void> =>
      Effect.promise(async () => {
        try {
          await reserved`SELECT pg_advisory_unlock(hashtext(${key}))`;
        } finally {
          reserved.release();
        }
      });

    return TransactionRunner.of({
      run: <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        Effect.provideService(withTransaction(eff), DbClient, db),
      withLock: <A, E, R>(key: string, eff: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          acquireLock(key),
          () => eff,
          (reserved) => releaseLock(key, reserved),
        ),
    });
  }),
);
