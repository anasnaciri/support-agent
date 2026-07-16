import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  makeDbClient,
  replyDeliveries,
  tenants,
  ticketStateTransitions,
  tickets,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import type { ApiConfig } from "../../../bootstrap.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("GET /dashboard/analytics/support (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const start = new Date("2026-07-01T00:00:00.000Z");
  const end = new Date("2026-08-01T00:00:00.000Z");
  const inside = new Date("2026-07-10T12:00:00.000Z");
  const autonomousTicketId = randomUUID();
  const approvedTicketId = randomUUID();
  const humanTicketId = randomUUID();
  const openTicketId = randomUUID();

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "support-analytics-state",
    shopify: {
      clientId: "client",
      clientSecret: "secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "support-analytics-approval",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      {
        id: tenantId,
        name: "support analytics",
        workosOrganizationId: orgId,
      },
      { id: otherTenantId, name: "other analytics tenant" },
    ]);
    await raw.db.insert(tickets).values([
      {
        id: autonomousTicketId,
        tenantId,
        channel: "email",
        status: "resolved",
        currentAgentId: "scenario-resolution-agent",
        context: { scenarioKey: "where_is_order" },
        createdAt: inside,
        resolvedAt: new Date(inside.getTime() + 60 * 60_000),
      },
      {
        id: approvedTicketId,
        tenantId,
        channel: "email",
        status: "resolved",
        currentAgentId: "scenario-resolution-agent",
        context: { scenarioKey: "where_is_order" },
        createdAt: inside,
        resolvedAt: new Date(inside.getTime() + 2 * 60 * 60_000),
      },
      {
        id: humanTicketId,
        tenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "scenario-resolution-agent",
        context: { scenarioKey: "refund_request" },
        createdAt: inside,
      },
      {
        id: openTicketId,
        tenantId,
        channel: "email",
        status: "waiting_for_customer",
        currentAgentId: "scenario-resolution-agent",
        createdAt: inside,
      },
      {
        id: randomUUID(),
        tenantId: otherTenantId,
        channel: "email",
        status: "resolved",
        currentAgentId: "scenario-resolution-agent",
        createdAt: inside,
        resolvedAt: inside,
      },
    ]);
    await raw.db.insert(ticketStateTransitions).values({
      ticketId: humanTicketId,
      fromStatus: "in_progress",
      toStatus: "human_takeover",
      reason: "manager requested takeover",
      occurredAt: inside,
    });
    await raw.db.insert(auditLog).values([
      {
        tenantId,
        ticketId: autonomousTicketId,
        actorType: "agent",
        actorId: "scenario-resolution-agent",
        action: "tool.invoked",
        details: {
          tool: "conversation.reply",
          ok: true,
          callId: "reply-autonomous",
        },
        occurredAt: new Date(inside.getTime() + 10 * 60_000),
      },
      {
        tenantId,
        ticketId: approvedTicketId,
        actorType: "agent",
        actorId: "scenario-resolution-agent",
        action: "tool.invoked",
        details: {
          tool: "conversation.reply",
          ok: true,
          callId: "reply-approved",
        },
        occurredAt: new Date(inside.getTime() + 20 * 60_000),
      },
      {
        tenantId,
        ticketId: autonomousTicketId,
        actorType: "agent",
        actorId: "scenario-resolution-agent",
        action: "tool.invoked",
        details: {
          tool: "refund.create",
          ok: true,
          callId: "refund-agent",
          amountMinorUnits: 1200,
          currencyCode: "USD",
        },
        occurredAt: new Date(inside.getTime() + 40 * 60_000),
      },
      {
        tenantId,
        ticketId: approvedTicketId,
        actorType: "user",
        actorId: randomUUID(),
        action: "ticket.refund_issued",
        details: {
          amount: "5.00",
          currencyCode: "USD",
          via: "dashboard",
        },
        occurredAt: new Date(inside.getTime() + 45 * 60_000),
      },
      {
        tenantId,
        ticketId: autonomousTicketId,
        actorType: "agent",
        actorId: "scenario-resolution-agent",
        action: "ticket.resolved",
        details: { reason: "runtime: final_message" },
        occurredAt: new Date(inside.getTime() + 60 * 60_000),
      },
      {
        tenantId,
        ticketId: approvedTicketId,
        actorType: "user",
        actorId: randomUUID(),
        action: "ticket.resolved",
        details: { reason: "approved tool conversation.reply" },
        occurredAt: new Date(inside.getTime() + 2 * 60 * 60_000),
      },
      {
        tenantId,
        ticketId: humanTicketId,
        actorType: "user",
        actorId: randomUUID(),
        action: "ticket.taken_over",
        details: { reason: "manager requested takeover" },
        occurredAt: inside,
      },
      {
        tenantId,
        ticketId: humanTicketId,
        actorType: "user",
        actorId: randomUUID(),
        action: "ticket.replied",
        details: { via: "manual_reply" },
        occurredAt: new Date(inside.getTime() + 30 * 60_000),
      },
    ]);
    await raw.db.insert(approvals).values([
      {
        id: randomUUID(),
        tenantId,
        ticketId: autonomousTicketId,
        agentId: "scenario-resolution-agent",
        tool: "conversation.reply",
        proposedInput: { bodyText: "Original" },
        riskLevel: "medium",
        status: "approved",
        decidedBy: randomUUID(),
        decidedAt: inside,
        createdAt: new Date(inside.getTime() - 10 * 60_000),
        expiresAt: end,
      },
      {
        id: randomUUID(),
        tenantId,
        ticketId: approvedTicketId,
        agentId: "scenario-resolution-agent",
        tool: "conversation.reply",
        proposedInput: { bodyText: "Original" },
        approvedInput: { bodyText: "Edited" },
        riskLevel: "medium",
        status: "approved",
        decidedBy: randomUUID(),
        decidedAt: inside,
        createdAt: new Date(inside.getTime() - 20 * 60_000),
        expiresAt: end,
      },
      {
        id: randomUUID(),
        tenantId,
        ticketId: humanTicketId,
        agentId: "scenario-resolution-agent",
        tool: "conversation.reply",
        proposedInput: { bodyText: "Declined" },
        riskLevel: "medium",
        status: "rejected",
        decidedBy: randomUUID(),
        decidedAt: inside,
        createdAt: new Date(inside.getTime() - 30 * 60_000),
        expiresAt: end,
      },
    ]);
    await raw.db.insert(replyDeliveries).values({
      tenantId,
      ticketId: humanTicketId,
      agentId: "scenario-resolution-agent",
      tool: "conversation.reply",
      draftId: randomUUID(),
      draft: { bodyText: "Could not send" },
      status: "abandoned",
      attempts: 6,
      maxAttempts: 6,
      createdAt: inside,
      updatedAt: inside,
      nextAttemptAt: inside,
    });

    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db
        .delete(replyDeliveries)
        .where(sql`${replyDeliveries.tenantId} = ${id}`);
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("returns tenant-scoped cohort and activity analytics with explicit denominators", async () => {
    if (!raw) return;
    const params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
    });
    const res = await fetch(
      `${baseUrl}/dashboard/analytics/support?${params.toString()}`,
      { headers: dashboardAuthHeaders(orgId) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.period).toEqual({
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: "UTC",
    });
    expect(body.cohort.ticketsCreated).toBe(4);
    expect(body.cohort.resolutionRate).toEqual({
      count: 2,
      total: 4,
      percentage: 50,
    });
    expect(body.cohort.handoffRate).toEqual({
      count: 1,
      total: 4,
      percentage: 25,
    });
    expect(body.cohort.handoffs).toEqual({
      merchantTakeovers: 1,
      automaticEscalations: 0,
    });
    expect(body.cohort.resolutionOwnership).toEqual({
      agentAssisted: 2,
      humanHandled: 1,
      unresolved: 1,
    });
    expect(body.cohort.topScenarios).toEqual([
      { scenarioKey: "where_is_order", count: 2, percentage: 50 },
      { scenarioKey: "refund_request", count: 1, percentage: 25 },
    ]);
    expect(body.cohort.unclassifiedTickets).toBe(1);
    expect(body.activity.drafts).toEqual({
      decided: 3,
      accepted: { count: 2, total: 3, percentage: 66.7 },
      acceptedWithoutEdit: 1,
      editedThenAccepted: 1,
      declined: 1,
    });
    expect(body.activity.ticketsResolved).toBe(2);
    expect(body.activity.medianFirstResponseMinutes).toBe(20);
    expect(body.activity.medianResolutionMinutes).toBe(90);
    expect(body.activity.medianApprovalWaitMinutes).toBe(20);
    expect(body.activity.refunds).toEqual({
      total: 2,
      issuedByAgent: 1,
      issuedByHuman: 1,
      valueByCurrency: [{ currencyCode: "USD", amountMinorUnits: 1700 }],
    });
    expect(body.activity.customerReplyDeliveries).toEqual({
      failed: 0,
      abandoned: 1,
    });
    expect(body.backlog).toEqual({
      total: 2,
      byStatus: [
        { status: "human_takeover", count: 1 },
        { status: "waiting_for_customer", count: 1 },
      ],
    });
  });
});
