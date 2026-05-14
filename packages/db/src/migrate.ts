import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgres://support_agent:support_agent@localhost:5432/support_agent";

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });
await sql.end();
console.log("migration complete");
