import { Context, Effect, Layer } from "effect";
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
