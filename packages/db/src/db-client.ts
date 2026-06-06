import { Cause, Context, Effect, FiberRef, Layer, Runtime } from "effect";
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
// Sentinel rejection used to roll back the SQL transaction when the inner
// Effect fails. Carries the original Cause so the outer Effect fails with it
// — distinct from a commit/connection error, which is NOT one of these.
class InnerEffectFailure<E> {
  readonly _tag = "InnerEffectFailure";
  constructor(readonly cause: Cause.Cause<E>) {}
}

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
      // CRITICAL: only resume SUCCESS after `db.transaction(...)` RESOLVES,
      // i.e. after the COMMIT succeeds. Resuming success from inside the
      // callback (before the commit) would report success even if Postgres
      // then rolled the transaction back (e.g. a deferred-constraint or
      // commit-time failure). The inner effect's value is returned from the
      // callback so Drizzle commits, then `.then` routes it.
      db.transaction(async (tx) => {
        const txAsDb = tx as unknown as DrizzleDb;
        const exit = await Runtime.runPromiseExit(runtime)(
          Effect.locally(eff, CurrentTxRef, txAsDb),
        );
        if (exit._tag === "Success") {
          return exit.value;
        }
        // Reject so Drizzle rolls the SQL transaction back, carrying the
        // cause for the outer Effect.
        throw new InnerEffectFailure(exit.cause);
      }).then(
        (value) => resume(Effect.succeed(value)),
        (err: unknown) => {
          if (err instanceof InnerEffectFailure) {
            resume(Effect.failCause(err.cause as Cause.Cause<E>));
            return;
          }
          // Commit / connection error AFTER the inner effect succeeded — the
          // data did NOT persist. Surface it as a defect so the caller never
          // sees success on a rolled-back transaction.
          resume(Effect.die(err));
        },
      );
    });
  });
