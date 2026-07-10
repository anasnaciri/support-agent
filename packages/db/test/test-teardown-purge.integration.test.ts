import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditLog,
  tickets,
  makeDbClient,
  tenants,
} from "../src/index.js";
import { purgeLeakedTenants } from "../src/test-teardown-purge.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Regression test for the vitest global-teardown FK bug: the backstop deleted
// leaked tenants with a single `DELETE FROM tenants`, which is blocked because
// `tickets.tenant_id` and `approvals.{tenant_id,ticket_id}` are ON DELETE NO ACTION.
// A test tenant that created a ticket (or approval) therefore blocked its own
// teardown delete (swallowed FK violation) and accumulated, polluting the
// shared dev DB. purgeLeakedTenants must delete in dependency order.
//
// This file runs against the shared dev DB alongside every other integration
// test, so it must never purge by keep-list alone: the keep-list is a snapshot,
// and any tenant a concurrent test file creates after that snapshot would be
// deleted out from under it (and, in the other direction, a ticket inserted
// between the ticket delete and the tenant delete fails this test on an FK
// violation). Every call below passes `onlyTenantIds` to bound the blast radius
// to the tenants this file seeded.
describeIfDb("purgeLeakedTenants (teardown backstop, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  // A tenant that must survive (stands in for real dev data already present
  // before the suite ran) and a "leaked" tenant with a full child graph.
  const keepTenantId = randomUUID();
  const leakedTenantId = randomUUID();
  const leakedTicketId = randomUUID();
  // Stands in for a tenant a concurrent test file creates while this purge is
  // in flight: absent from the keep-list, but out of scope for this purge.
  const bystanderTenantId = randomUUID();
  const bystanderTicketId = randomUUID();

  const allTenantIds = [keepTenantId, leakedTenantId, bystanderTenantId];

  let deleted: string[] = [];

  beforeAll(async () => {
    if (!raw) return;
    for (const id of allTenantIds) {
      await raw.db.insert(tenants).values({ id, name: `purge-test-${id}` });
    }
    // The leaked tenant owns the exact rows whose NO ACTION FKs broke teardown.
    await raw.db.insert(tickets).values({
      id: leakedTicketId,
      tenantId: leakedTenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
    });
    await raw.db.insert(approvals).values({
      id: randomUUID(),
      tenantId: leakedTenantId,
      ticketId: leakedTicketId,
      agentId: "support-triage",
      tool: "refund.create",
      proposedInput: { amountCents: 2000 },
      riskLevel: "high",
      status: "pending",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await raw.db.insert(auditLog).values({
      tenantId: leakedTenantId,
      ticketId: leakedTicketId,
      actorType: "system",
      action: "ticket.created",
      details: {},
    });
    // The bystander owns a ticket too, so a purge that ignored `onlyTenantIds`
    // would either delete it or trip the same FK it deletes in dependency order.
    await raw.db.insert(tickets).values({
      id: bystanderTicketId,
      tenantId: bystanderTenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
    });

    // Keep-list holds only the tenant that must survive; scope holds the two
    // tenants this file owns. The bystander is in neither.
    deleted = await purgeLeakedTenants(raw.sql, [keepTenantId], {
      onlyTenantIds: [keepTenantId, leakedTenantId],
    });
  });

  afterAll(async () => {
    if (!raw) return;
    // Belt-and-braces cleanup of anything the test itself left (dependency
    // order, so it works regardless of whether purge ran).
    for (const id of allTenantIds) {
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${id}`);
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  const tenantExists = async (id: string): Promise<boolean> => {
    const rows = await raw!.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.id} = ${id}`);
    return rows.length === 1;
  };

  it("deletes a leaked tenant that owns tickets + approvals, keeping the snapshot", async () => {
    if (!raw) return;

    expect(deleted).toContain(leakedTenantId);
    expect(deleted).not.toContain(keepTenantId);

    // The leaked tenant and its whole child graph are gone...
    expect(await tenantExists(leakedTenantId)).toBe(false);

    const ticketRows = await raw.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(sql`${tickets.tenantId} = ${leakedTenantId}`);
    expect(ticketRows).toHaveLength(0);

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
    expect(await tenantExists(keepTenantId)).toBe(true);
  });

  it("leaves a tenant outside onlyTenantIds alone even though it is not in the keep-list", async () => {
    if (!raw) return;

    expect(deleted).not.toContain(bystanderTenantId);
    expect(await tenantExists(bystanderTenantId)).toBe(true);

    // Its child rows survive too — an unscoped `DELETE FROM tickets` would have
    // taken this even if the tenant row happened to survive.
    const ticketRows = await raw.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(sql`${tickets.tenantId} = ${bystanderTenantId}`);
    expect(ticketRows).toHaveLength(1);
  });

  // The unscoped form (`onlyTenantIds` omitted, keep-list only) is deliberately
  // NOT exercised here. It deletes every tenant absent from a snapshot, so
  // against the shared dev DB it would delete whatever a concurrent test file
  // created after the snapshot was taken — the very race this scoping exists to
  // close. Only the global teardown may call it, after the suite has finished.
});
