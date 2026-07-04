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

    /**
     * Run `eff` while holding a cluster-wide exclusive lock on `key`
     * (audit L2). The Live impl takes a Postgres advisory lock on a
     * dedicated connection, so two workers — or two pg-boss jobs whose
     * queue keys differ (thread-keyed message vs ticket-keyed approval) —
     * can never tick the same ticket concurrently. Released on success,
     * failure, or interruption.
     */
    readonly withLock: <A, E, R>(
      key: string,
      eff: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}

/**
 * Pass-through Test layer. Inner Effect runs unwrapped; failures don't roll
 * anything back because the in-memory Test repositories aren't backed by SQL.
 * `withLock` is a no-op — in-memory tests are single-process.
 */
export const TransactionRunnerPassthrough = Layer.succeed(
  TransactionRunner,
  TransactionRunner.of({
    run: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    withLock: <A, E, R>(_key: string, eff: Effect.Effect<A, E, R>) => eff,
  }),
);
