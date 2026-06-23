import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditLog,
  cases,
  makeDbClient,
  tenants,
} from "../src/index.js";
import { purgeLeakedTenants } from "../src/test-teardown-purge.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Regression test for the vitest global-teardown FK bug: the backstop deleted
// leaked tenants with a single `DELETE FROM tenants`, which is blocked because
// `cases.tenant_id` and `approvals.{tenant_id,case_id}` are ON DELETE NO ACTION.
// A test tenant that created a case (or approval) therefore blocked its own
// teardown delete (swallowed FK violation) and accumulated, polluting the
// shared dev DB. purgeLeakedTenants must delete in dependency order.
describeIfDb("purgeLeakedTenants (teardown backstop, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  // A tenant that must survive (stands in for real dev data already present
  // before the suite ran) and a "leaked" tenant with a full child graph.
  const keepTenantId = randomUUID();
  const leakedTenantId = randomUUID();
  const leakedCaseId = randomUUID();

  beforeAll(async () => {
    if (!raw) return;
    for (const id of [keepTenantId, leakedTenantId]) {
      await raw.db.insert(tenants).values({ id, name: `purge-test-${id}` });
    }
    // The leaked tenant owns the exact rows whose NO ACTION FKs broke teardown.
    await raw.db.insert(cases).values({
      id: leakedCaseId,
      tenantId: leakedTenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
    });
    await raw.db.insert(approvals).values({
      id: randomUUID(),
      tenantId: leakedTenantId,
      caseId: leakedCaseId,
      agentId: "support-triage",
      tool: "refund.create",
      proposedInput: { amountCents: 2000 },
      riskLevel: "high",
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await raw.db.insert(auditLog).values({
      tenantId: leakedTenantId,
      caseId: leakedCaseId,
      actorType: "system",
      action: "case.created",
      details: {},
    });
  });

  afterAll(async () => {
    if (!raw) return;
    // Belt-and-braces cleanup of anything the test itself left (dependency
    // order, so it works regardless of whether purge ran).
    for (const id of [keepTenantId, leakedTenantId]) {
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("deletes a leaked tenant that owns cases + approvals, keeping the snapshot", async () => {
    if (!raw) return;

    // Snapshot = "every tenant that existed before, EXCEPT the leaked one".
    const before = (
      await raw.sql<{ id: string }[]>`SELECT id FROM tenants`
    )
      .map((r) => r.id)
      .filter((id) => id !== leakedTenantId);

    const deleted = await purgeLeakedTenants(raw.sql, before);

    expect(deleted).toContain(leakedTenantId);
    expect(deleted).not.toContain(keepTenantId);

    // The leaked tenant and its whole child graph are gone...
    const tenantRows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.id} = ${leakedTenantId}`);
    expect(tenantRows).toHaveLength(0);

    const caseRows = await raw.db
      .select({ id: cases.id })
      .from(cases)
      .where(sql`${cases.tenantId} = ${leakedTenantId}`);
    expect(caseRows).toHaveLength(0);

    const approvalRows = await raw.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(sql`${approvals.tenantId} = ${leakedTenantId}`);
    expect(approvalRows).toHaveLength(0);

    const auditRows = await raw.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.tenantId} = ${leakedTenantId}`);
    expect(auditRows).toHaveLength(0);

    // ...but the kept tenant is untouched.
    const keptRows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.id} = ${keepTenantId}`);
    expect(keptRows).toHaveLength(1);
  });
});
