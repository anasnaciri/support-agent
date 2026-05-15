import { Context, Effect, Layer } from "effect";

/**
 * Runs the given Effect inside a database transaction. Every repository call
 * inside `eff` joins the same SQL transaction; if the Effect fails, all
 * writes are rolled back.
 *
 * The Tag stays in services so that orchestrators (AgentRuntime) can depend
 * on it abstractly. The pg/Drizzle-specific implementation lives in the db
 * package as `TransactionRunnerLive`. The default Test implementation is a
 * pass-through — useful when running against in-memory Test repositories
 * where there's no real database transaction to wrap.
 */
export class TransactionRunner extends Context.Tag("TransactionRunner")<
  TransactionRunner,
  {
    readonly run: <A, E, R>(
      eff: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}

/**
 * Pass-through Test layer. Inner Effect runs unwrapped; failures don't roll
 * anything back because the in-memory Test repositories aren't backed by SQL.
 */
export const TransactionRunnerPassthrough = Layer.succeed(
  TransactionRunner,
  TransactionRunner.of({
    run: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
  }),
);
