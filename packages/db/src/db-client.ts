import { Context, Effect, FiberRef, Layer, Runtime } from "effect";
import {
  makeDbClient,
  type DrizzleDb,
  type DbClientOptions,
} from "./client.js";

/**
 * Effect Tag wrapping the underlying Drizzle instance, so Live layers in
 * other packages can depend on `DbClient` rather than receiving a raw client.
 */
export class DbClient extends Context.Tag("DbClient")<DbClient, DrizzleDb>() {}

/**
 * Per-fiber transaction handle. The default is `null` (no active tx); inside
 * `withTransaction(...)` we set it to the active Drizzle tx via
 * `Effect.locally` for the scope of the inner Effect.
 *
 * Why FiberRef and not a service Tag: this is the *cross-cutting* hook that
 * every Live repository checks. Putting it in `Context.Tag<T, R>` would
 * surface `T` into every repository method's R, contaminating the Tag
 * interface and forcing the in-memory Test layers to also satisfy a
 * dependency they don't actually need. `FiberRef.get` is bookkeeping that
 * doesn't appear in R.
 */
export const CurrentTxRef = FiberRef.unsafeMake<DrizzleDb | null>(null);

/**
 * Layer that builds a Drizzle connection from `DbClientOptions` and exposes
 * it via the `DbClient` Tag. Manages connection lifecycle via Effect's scope
 * (closes the pool on shutdown).
 */
export const DbClientLive = (opts: DbClientOptions) =>
  Layer.scoped(
    DbClient,
    Effect.acquireRelease(
      Effect.sync(() => makeDbClient(opts)),
      (handle) => Effect.promise(() => handle.close()),
    ).pipe(Effect.map((handle) => handle.db)),
  );

/**
 * Runs the given Effect inside a Drizzle transaction. Repositories that
 * consult `CurrentTxRef` will use the active `tx` for every query within
 * the inner Effect's scope; outside this call they keep using the bare
 * `DbClient`.
 *
 * Use this to enforce the master-plan §4 audit-in-transaction invariant:
 * compose `CaseRepository.transitionStatus(...)` and
 * `AuditLogService.record(...)` inside one `withTransaction(...)` and
 * they share one SQL transaction. Effect failure → Postgres rollback.
 */
export const withTransaction = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | DbClient> =>
  Effect.gen(function* () {
    const db = yield* DbClient;
    // Capture the outer Runtime so we can run `eff` (which has R deps)
    // inside Drizzle's tx callback. Effect.async on its own would force
    // R = never; Runtime.runPromiseExit threads the parent env through.
    const runtime = yield* Effect.runtime<R>();
    return yield* Effect.async<A, E>((resume) => {
      db.transaction(async (tx) => {
        const txAsDb = tx as unknown as DrizzleDb;
        const exit = await Runtime.runPromiseExit(runtime)(
          Effect.locally(eff, CurrentTxRef, txAsDb),
        );
        if (exit._tag === "Success") {
          resume(Effect.succeed(exit.value));
          return;
        }
        resume(Effect.failCause(exit.cause));
        // throw to roll back the SQL transaction
        throw new Error("withTransaction: inner effect failed (rollback)");
      }).catch(() => {
        // already routed to resume() above; swallow Drizzle's rethrow
      });
    });
  });
