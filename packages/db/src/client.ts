import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export interface DbClientOptions {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
}

export const makeDbClient = (opts: DbClientOptions) => {
  const sql = postgres(opts.databaseUrl, {
    max: opts.maxConnections ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
};

export type DbClient = ReturnType<typeof makeDbClient>["db"];
