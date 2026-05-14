import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgres://support_agent:support_agent@localhost:5432/support_agent";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
