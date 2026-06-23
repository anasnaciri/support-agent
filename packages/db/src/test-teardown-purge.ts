import type { makeDbClient } from "./client.js";

type RawSql = ReturnType<typeof makeDbClient>["sql"];

/**
 * Remove every tenant NOT in `keepTenantIds`, plus the tenant-scoped rows that
 * would otherwise be orphaned or block the delete. The test-suite backstop
 * (see `vitest.global-teardown.ts`) calls this after the whole run so the DB is
 * left exactly as the suite found it.
 *
 * Ordering matters: `cases.tenant_id` and `approvals.{tenant_id,case_id}` are
 * `ON DELETE NO ACTION` (intentional — the schema refuses to silently wipe a
 * tenant that still owns cases). So a bare `DELETE FROM tenants` is blocked by
 * any leftover case, and a `DELETE FROM cases` is blocked by any leftover
 * approval. We therefore delete in dependency order — the same order
 * `redactShop` uses in production: approvals → cases → audit_log → tenants.
 * Everything else under a tenant (`case_state_transitions`, `case_message_ids`,
 * `connector_connections`, knowledge docs, agent overrides, roles, …) is
 * `ON DELETE CASCADE`, so the tenant delete carries it.
 *
 * `audit_log` has no FK at all (tenant-scoped by column only), so it neither
 * blocks the delete nor cascades — we delete it explicitly to avoid leaking
 * orphan audit rows.
 *
 * `x <> ALL('{}'::uuid[])` is TRUE for every `x`, so an empty keep-list deletes
 * every tenant (the correct "keep nothing" semantics).
 *
 * @returns the ids of the tenants that were deleted.
 */
export const purgeLeakedTenants = async (
  sql: RawSql,
  keepTenantIds: readonly string[],
): Promise<string[]> => {
  const keep = keepTenantIds as string[];
  // 1. approvals — FK to BOTH cases and tenants (NO ACTION); nuke by tenant.
  await sql`DELETE FROM approvals WHERE tenant_id <> ALL(${keep}::uuid[])`;
  // 2. cases — FK to tenants (NO ACTION); cascades case_state_transitions,
  //    case_message_ids, reply_deliveries, case_supplier_escalations, …
  await sql`DELETE FROM cases WHERE tenant_id <> ALL(${keep}::uuid[])`;
  // 3. audit_log — no FK; would orphan tenant-scoped rows otherwise.
  await sql`DELETE FROM audit_log WHERE tenant_id <> ALL(${keep}::uuid[])`;
  // 4. tenants — everything still attached cascades from here.
  const deleted = await sql<{ id: string }[]>`
    DELETE FROM tenants
    WHERE id <> ALL(${keep}::uuid[])
    RETURNING id
  `;
  return deleted.map((r) => r.id);
};
