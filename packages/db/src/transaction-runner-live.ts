import { Effect, Layer } from "effect";
import { TransactionRunner } from "@support-agent/services";
import { DbClient, withTransaction } from "./db-client.js";

/**
 * Live implementation: every `run(eff)` opens a Drizzle transaction, swaps
 * the `CurrentTxRef` FiberRef so every repository call inside `eff` uses the
 * tx, and rolls back on Effect failure.
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
    return TransactionRunner.of({
      run: <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        Effect.provideService(withTransaction(eff), DbClient, db),
    });
  }),
);
