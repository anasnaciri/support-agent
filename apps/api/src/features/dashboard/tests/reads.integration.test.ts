import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  ticketDetail,
  tickets,
  ticketsList,
  createSupplier,
  insertEscalation,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import type { ApiConfig } from "../../../bootstrap.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// GET /dashboard/today — the Today-view read endpoint the Cloudflare-Workers
// dashboard calls instead of querying Postgres directly (Path B).
describeIfDb("apps/api — GET /dashboard/today (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const cfg: ApiConfig = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "test-state-key",
    shopify: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "test-approval-key",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const mkTicket = (
    id: string,
    owner: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    tenantId: owner,
    channel: "email",
    status,
    currentAgentId: "support-triage",
    ...extra,
  });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "dash-today-test", workosOrganizationId: orgId },
      {
        id: otherTenantId,
        name: "dash-today-other",
        workosOrganizationId: otherOrgId,
      },
    ]);

    const now = new Date();
    const approvalTicketId = randomUUID();
    await raw.db.insert(tickets).values([
      mkTicket(randomUUID(), tenantId, "resolved", { resolvedAt: now }),
      mkTicket(randomUUID(), tenantId, "human_takeover", {
        subject: "Where is my order?",
        category: "where_is_order",
      }),
      mkTicket(approvalTicketId, tenantId, "waiting_for_approval"),
      mkTicket(randomUUID(), tenantId, "in_progress"),
      // Different tenant — must NOT leak into tenant1's counts.
      mkTicket(randomUUID(), otherTenantId, "resolved", { resolvedAt: now }),
    ]);

    await raw.db.insert(approvals).values({
      id: randomUUID(),
      tenantId,
      ticketId: approvalTicketId,
      agentId: "refund-review-agent",
      tool: "refund.create",
      proposedInput: { amount: 1000 },
      riskLevel: "high",
      status: "pending",
      expiresAt: new Date(now.getTime() + 86_400_000),
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
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  const get = (headers: Record<string, string>) =>
    fetch(`${baseUrl}/dashboard/today`, { headers });

  it("returns tenant-scoped Today data for a valid token + org", async () => {
    if (!raw) return;
    const res = await get(dashboardAuthHeaders(orgId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      statusCounts: Record<string, number>;
      resolvedTodayCount: number;
      pendingApprovals: ReadonlyArray<{ tool: string; riskLevel: string }>;
      takeoverTickets: ReadonlyArray<{ subject: string | null }>;
    };

    expect(body.statusCounts["resolved"]).toBe(1); // not 2 — other tenant excluded
    expect(body.statusCounts["human_takeover"]).toBe(1);
    expect(body.statusCounts["waiting_for_approval"]).toBe(1);
    expect(body.statusCounts["in_progress"]).toBe(1);
    expect(body.resolvedTodayCount).toBe(1);
    expect(body.pendingApprovals).toHaveLength(1);
    expect(body.pendingApprovals[0]?.tool).toBe("refund.create");
    expect(body.takeoverTickets).toHaveLength(1);
    expect(body.takeoverTickets[0]?.subject).toBe("Where is my order?");
  });

  it("rejects a missing/invalid token with 401", async () => {
    if (!raw) return;
    const res = await get({});
    expect(res.status).toBe(401);
  });

  it("rejects an unknown organization with 403", async () => {
    if (!raw) return;
    const res = await get(dashboardAuthHeaders("org_does_not_exist"));
    expect(res.status).toBe(403);
  });
});

// Concurrent wait states: a ticket parked `waiting_for_approval` can ALSO carry
// an open supplier escalation. ticketsList + ticketDetail derive BOTH facts from
// rows (pending approvals / open escalations) into `waitingOn` so the dashboard
// can render a second "waiting on supplier" chip.
describeIfDb("apps/api — dashboard reads waitingOn (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();

  // A ticket with BOTH a pending approval and an open escalation.
  const bothTicketId = randomUUID();
  // A ticket with only a pending approval (no escalation).
  const approvalOnlyTicketId = randomUUID();
  // A plain in_progress ticket with neither.
  const plainTicketId = randomUUID();

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({
      id: tenantId,
      name: "waiting-on-test",
      workosOrganizationId: orgId,
    });
    const supplier = await createSupplier(raw.db, tenantId, {
      name: "WH",
      email: "wh@waiting.test",
    });
    await raw.db.insert(tickets).values([
      {
        id: bothTicketId,
        tenantId,
        channel: "email",
        status: "waiting_for_approval",
        currentAgentId: "missing-package-agent",
      },
      {
        id: approvalOnlyTicketId,
        tenantId,
        channel: "email",
        status: "waiting_for_approval",
        currentAgentId: "support-triage",
      },
      {
        id: plainTicketId,
        tenantId,
        channel: "email",
        status: "in_progress",
        currentAgentId: "support-triage",
      },
    ]);
    for (const ticketId of [bothTicketId, approvalOnlyTicketId]) {
      await raw.db.insert(approvals).values({
        id: randomUUID(),
        tenantId,
        ticketId,
        agentId: "support-triage",
        tool: "conversation.reply",
        proposedInput: { draftId: randomUUID(), bodyText: "draft" },
        riskLevel: "medium",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }
    await insertEscalation(raw.db, {
      tenantId,
      ticketId: bothTicketId,
      supplierId: supplier.id,
      problem: "P",
      orderRef: null,
      shipCity: null,
      shipCountry: null,
      trackingNumber: null,
    });
  });

  afterAll(async () => {
    if (!raw) return;
    // approvals is NO ACTION → before tickets; tickets cascades escalations; tenant
    // cascades the supplier.
    await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${tenantId}`);
    await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("ticketsList derives waitingOn per ticket (approval + supplier)", async () => {
    if (!raw) return;
    const page = await ticketsList(raw.db, tenantId, {}, 1, 50);
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    expect(byId.get(bothTicketId)?.waitingOn).toEqual({
      approval: true,
      supplier: true,
    });
    expect(byId.get(approvalOnlyTicketId)?.waitingOn).toEqual({
      approval: true,
      supplier: false,
    });
    expect(byId.get(plainTicketId)?.waitingOn).toEqual({
      approval: false,
      supplier: false,
    });
  });

  it("ticketDetail derives waitingOn (both waits held at once)", async () => {
    if (!raw) return;
    const detail = await ticketDetail(raw.db, tenantId, bothTicketId);
    expect(detail?.ticket.waitingOn).toEqual({ approval: true, supplier: true });
  });
});
