import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  caseStateTransitions,
  cases,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("db schema (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  it("connects and runs SELECT 1", async () => {
    const result = await client.sql`SELECT 1 AS x`;
    expect(result[0]).toEqual({ x: 1 });
  });

  it("has all five Phase 1 tables", async () => {
    const rows = await client.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenants','cases','case_state_transitions','audit_log','approvals')
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      "approvals",
      "audit_log",
      "case_state_transitions",
      "cases",
      "tenants",
    ]);
  });

  it("insert + read round-trip across all five tables", async () => {
    const tenantId = randomUUID();
    const caseId = randomUUID();
    const approvalId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: "Acme" });
      await tx.insert(cases).values({
        id: caseId,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
      });
      await tx.insert(caseStateTransitions).values({
        caseId,
        fromStatus: "new",
        toStatus: "triaging",
      });
      await tx.insert(auditLog).values({
        tenantId,
        caseId,
        actorType: "system",
        action: "case.created",
        details: { source: "integration-test" },
      });
      await tx.insert(approvals).values({
        id: approvalId,
        tenantId,
        caseId,
        agentId: "support-triage",
        tool: "case.update_status",
        proposedInput: { status: "resolved" },
        riskLevel: "low",
        status: "pending",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });

    const round = await db
      .select({ status: cases.status })
      .from(cases)
      .where(sql`${cases.id} = ${caseId}`);
    expect(round[0]?.status).toBe("new");

    // cleanup so the test is rerunnable
    await db.transaction(async (tx) => {
      await tx.delete(approvals).where(sql`${approvals.id} = ${approvalId}`);
      await tx.delete(auditLog).where(sql`${auditLog.caseId} = ${caseId}`);
      await tx
        .delete(caseStateTransitions)
        .where(sql`${caseStateTransitions.caseId} = ${caseId}`);
      await tx.delete(cases).where(sql`${cases.id} = ${caseId}`);
      await tx.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    });
  });

  it("rejects invalid status via CHECK constraint", async () => {
    const tenantId = randomUUID();
    const caseId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Acme" });
    try {
      await expect(
        db.insert(cases).values({
          id: caseId,
          tenantId,
          channel: "email",
          status: "garbage_status",
          currentAgentId: "support-triage",
        }),
      ).rejects.toThrow();
    } finally {
      await db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    }
  });
});
