import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  ticketStateTransitions,
  tickets,
  connectorConnections,
  makeDbClient,
  processedMessages,
  tenants,
  timers,
  toolExecutions,
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

  it("has core runtime tables", async () => {
    const rows = await client.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('tenants','tickets','ticket_state_transitions','audit_log','approvals','timers')
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      "approvals",
      "audit_log",
      "tenants",
      "ticket_state_transitions",
      "tickets",
      "timers",
    ]);
  });

  it("insert + read round-trip across all six tables", async () => {
    const tenantId = randomUUID();
    const ticketId = randomUUID();
    const approvalId = randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: "Acme" });
      await tx.insert(tickets).values({
        id: ticketId,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
      });
      await tx.insert(ticketStateTransitions).values({
        ticketId,
        fromStatus: "new",
        toStatus: "triaging",
      });
      await tx.insert(auditLog).values({
        tenantId,
        ticketId,
        actorType: "system",
        action: "ticket.created",
        details: { source: "integration-test" },
      });
      await tx.insert(approvals).values({
        id: approvalId,
        tenantId,
        ticketId,
        agentId: "support-triage",
        tool: "ticket.update_status",
        proposedInput: { status: "resolved" },
        riskLevel: "low",
        status: "pending",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      await tx.insert(timers).values({
        id: randomUUID(),
        ticketId,
        fireAt: new Date(Date.now() + 60 * 60 * 1000),
        reason: "follow_up",
      });
    });

    const round = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(sql`${tickets.id} = ${ticketId}`);
    expect(round[0]?.status).toBe("new");

    // cleanup so the test is rerunnable
    await db.transaction(async (tx) => {
      await tx.delete(approvals).where(sql`${approvals.id} = ${approvalId}`);
      await tx.delete(timers).where(sql`${timers.ticketId} = ${ticketId}`);
      await tx.delete(auditLog).where(sql`${auditLog.ticketId} = ${ticketId}`);
      await tx
        .delete(ticketStateTransitions)
        .where(sql`${ticketStateTransitions.ticketId} = ${ticketId}`);
      await tx.delete(tickets).where(sql`${tickets.id} = ${ticketId}`);
      await tx.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    });
  });

  it("rejects invalid status via CHECK constraint", async () => {
    const tenantId = randomUUID();
    const ticketId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Acme" });
    try {
      await expect(
        db.insert(tickets).values({
          id: ticketId,
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

  // ============================================================
  // Audit 2026-06-10 data-layer items (D1, D2, D4, D5 + dedup tables)
  // ============================================================

  const seedTenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Schema Audit Test" });
    return id;
  };

  it("D1: rejects a second ACTIVE connector row for the same gmail mailbox across tenants", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const mailbox = `dup-${randomUUID()}@example.com`;
    const row = (tenantId: string) => ({
      id: randomUUID(),
      tenantId,
      provider: "gmail" as const,
      shopDomain: mailbox,
      accessTokenEncrypted: Buffer.from("x"),
      status: "active" as const,
    });
    try {
      await db.insert(connectorConnections).values(row(tenantA));
      await expect(
        db.insert(connectorConnections).values(row(tenantB)),
      ).rejects.toThrow();
      // A revoked row for the same mailbox is fine (reconnect history).
      await db
        .insert(connectorConnections)
        .values({ ...row(tenantB), status: "revoked" });
    } finally {
      await db.delete(tenants).where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
    }
  });

  it("D2: tickets carry a nullable conversation-provider stamp with a CHECK", async () => {
    const tenantId = await seedTenant();
    try {
      const stamped = randomUUID();
      await db.insert(tickets).values({
        id: stamped,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
        provider: "outlook",
      });
      const unstamped = randomUUID();
      await db.insert(tickets).values({
        id: unstamped,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
      });
      await expect(
        db.insert(tickets).values({
          id: randomUUID(),
          tenantId,
          channel: "email",
          status: "new",
          currentAgentId: "support-triage",
          provider: "smoke_signals",
        }),
      ).rejects.toThrow();
    } finally {
      await db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
      await db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    }
  });

  it("D4: rejects a second ticket with the same (tenant_id, thread_id)", async () => {
    const tenantId = await seedTenant();
    const threadId = `gmail:${randomUUID()}`;
    const first = randomUUID();
    try {
      await db.insert(tickets).values({
        id: first,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
        threadId,
      });
      await expect(
        db.insert(tickets).values({
          id: randomUUID(),
          tenantId,
          channel: "email",
          status: "new",
          currentAgentId: "support-triage",
          threadId,
        }),
      ).rejects.toThrow();
      // Two NULL-thread tickets are fine (the index is partial).
      const nullA = randomUUID();
      const nullB = randomUUID();
      await db.insert(tickets).values([
        { id: nullA, tenantId, channel: "email", status: "new", currentAgentId: "support-triage" },
        { id: nullB, tenantId, channel: "email", status: "new", currentAgentId: "support-triage" },
      ]);
    } finally {
      await db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
      await db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    }
  });

  it("D5: hot-path indexes exist (audit_log tenant scans, approvals.ticket_id)", async () => {
    const rows = await client.sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'audit_log_tenant_id_idx',
          'audit_log_tenant_action_occurred_idx',
          'approvals_ticket_idx'
        )
      ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual([
      "approvals_ticket_idx",
      "audit_log_tenant_action_occurred_idx",
      "audit_log_tenant_id_idx",
    ]);
  });

  it("processed_messages dedups on (tenant_id, provider, message_id)", async () => {
    const tenantId = await seedTenant();
    const messageId = `m-${randomUUID()}`;
    const row = {
      tenantId,
      provider: "gmail",
      messageId,
      threadId: "gmail:t1",
    };
    try {
      await db.insert(processedMessages).values(row);
      await expect(db.insert(processedMessages).values(row)).rejects.toThrow();
      // Same message id under another provider is a different message.
      await db.insert(processedMessages).values({ ...row, provider: "imap" });
    } finally {
      await db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    }
  });

  it("tool_executions dedups on (ticket_id, call_id)", async () => {
    const tenantId = await seedTenant();
    const ticketId = randomUUID();
    await db.insert(tickets).values({
      id: ticketId,
      tenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
    });
    const row = {
      tenantId,
      ticketId,
      callId: "call-1",
      tool: "refund.create",
      resultOk: true,
    };
    try {
      await db.insert(toolExecutions).values(row);
      await expect(db.insert(toolExecutions).values(row)).rejects.toThrow();
    } finally {
      await db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
      await db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    }
  });
});
