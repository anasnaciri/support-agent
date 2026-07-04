import { makeDbClient } from "./packages/db/src/client.js";
import { purgeLeakedTenants } from "./packages/db/src/test-teardown-purge.js";

// Safety net so the test database is left exactly as the suite found it.
//
// Per-test cleanup (afterAll/finally deleting seeded rows) is still the rule —
// see the *.integration.test.ts files. This is the backstop that catches the
// two ways per-test cleanup fails: a future test that forgets to delete its
// rows, and a test that crashes before its afterAll runs.
//
// How it works: snapshot the tenant ids that exist BEFORE the suite, then after
// the whole suite delete any tenant that wasn't in that snapshot. `tickets` and
// `approvals` are ON DELETE NO ACTION (intentional safety), so a leaked tenant
// that owns either would block its own `DELETE FROM tenants` — purgeLeakedTenants
// deletes in dependency order (approvals → tickets → audit_log → tenants), the same
// way redactShop does in production, and the tenant delete cascades the rest
// (tenant_knowledge_documents, tenant_agent_overrides, tickets → transitions,
// connector_connections, …). Pre-existing rows (real dev data like "Anas's
// Support Team") are in the snapshot and never touched.
//
// Limitation: non-tenant-scoped tables (admin_audit_log, pg-boss job tables) are
// not covered. The current suite doesn't leak into those; revisit if that
// changes. No-ops without DATABASE_URL (unit-only / no-DB runs).

export async function setup() {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) return; // no DB this run → nothing to snapshot, no teardown

  const { sql, close } = makeDbClient({ databaseUrl, maxConnections: 1 });
  let before: string[];
  try {
    const rows = await sql<{ id: string }[]>`SELECT id FROM tenants`;
    before = rows.map((r) => r.id);
  } finally {
    await close();
  }

  return async () => {
    const { sql, close } = makeDbClient({ databaseUrl, maxConnections: 1 });
    try {
      const deleted = await purgeLeakedTenants(sql, before);
      if (deleted.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[vitest teardown] removed ${deleted.length} tenant(s) left behind by the test run (a test skipped its own cleanup or crashed)`,
        );
      }
    } catch (err) {
      // A teardown failure shouldn't flip an otherwise-green run red; surface it
      // loudly instead so the leak doesn't pile up silently.
      // eslint-disable-next-line no-console
      console.error("[vitest teardown] tenant cleanup failed:", err);
    } finally {
      await close();
    }
  };
}
