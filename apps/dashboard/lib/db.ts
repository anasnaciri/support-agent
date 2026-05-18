import "server-only";
import { makeDbClient, type DrizzleDb } from "@support-agent/db";

// Singleton Drizzle client for Server Components. We import via the
// workspace package (transpiled by Next.js per `transpilePackages` in
// next.config.ts). Effect's `DbClient` Tag is used by the worker /
// api where transactions span service calls; the dashboard only does
// flat reads, so the raw Drizzle client is plenty.
//
// The `server-only` import at the top makes Next.js fail the build if
// any client component tries to import this module — keeps the
// DATABASE_URL + the pg pool out of the client bundle.

let cached: DrizzleDb | null = null;

export const db = (): DrizzleDb => {
  if (cached) return cached;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for dashboard server components",
    );
  }
  cached = makeDbClient({ databaseUrl }).db;
  return cached;
};
