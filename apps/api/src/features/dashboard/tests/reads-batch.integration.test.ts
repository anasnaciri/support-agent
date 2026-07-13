import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  tickets,
  connectorConnections,
  makeDbClient,
  tenantAgentOverrides,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// tickets/approvals/audit read endpoints (Path B, slices 2-4).
describeIfDb("apps/api — /dashboard read endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-batch-token";
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const ticketA = randomUUID(); // resolved, 2 audit rows, 0 approvals
  const ticketB = randomUUID(); // waiting_for_approval, 1 audit row, 1 pending approval
  const ticketC = randomUUID(); // human_takeover
  const ticketX = randomUUID(); // OTHER tenant
  const approvalId = randomUUID();
  const approvedApprovalId = randomUUID(); // approved, low risk
  const rejectedApprovalId = randomUUID(); // rejected, medium risk

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "k",
    shopify: {
      clientId: "c",
      clientSecret: "s",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "a",
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
  const mkAudit = (
    ticketId: string,
    owner: string,
    action: string,
    actorType: string,
  ) => ({ tenantId: owner, ticketId, action, actorType, details: {} });

  const auth = dashboardAuthHeaders(orgId);
  const get = (path: string, headers: Record<string, string> = auth) =>
    fetch(`${baseUrl}${path}`, { headers });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "batch", workosOrganizationId: orgId },
      { id: otherTenantId, name: "batch-other", workosOrganizationId: otherOrgId },
    ]);
    await raw.db.insert(tickets).values([
      mkTicket(ticketA, tenantId, "resolved", {
        subject: "Ticket A",
        context: { scenarioKey: "where_is_order" },
        resolvedAt: new Date(),
      }),
      mkTicket(ticketB, tenantId, "waiting_for_approval", {
        subject: "Ticket B",
        shopifyOrderId: "#1001",
      }),
      mkTicket(ticketC, tenantId, "human_takeover", {
        subject: "Ticket C",
        summary: "priority widget escalation",
      }),
      mkTicket(ticketX, otherTenantId, "resolved", { subject: "Ticket X" }),
    ]);
    await raw.db.insert(auditLog).values([
      mkAudit(ticketA, tenantId, "event.received", "system"),
      mkAudit(ticketA, tenantId, "tool.invoked", "agent"),
      mkAudit(ticketB, tenantId, "llm.decision", "agent"),
      mkAudit(ticketX, otherTenantId, "event.received", "system"),
    ]);
    await raw.db.insert(approvals).values([
      {
        id: approvalId,
        tenantId,
        ticketId: ticketB,
        agentId: "refund-review-agent",
        tool: "refund.create",
        proposedInput: { amount: 500 },
        riskLevel: "high",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        id: approvedApprovalId,
        tenantId,
        ticketId: ticketC,
        agentId: "refund-review-agent",
        tool: "refund.create",
        proposedInput: { amount: 100 },
        riskLevel: "low",
        status: "approved",
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        id: rejectedApprovalId,
        tenantId,
        ticketId: ticketC,
        agentId: "refund-review-agent",
        tool: "refund.create",
        proposedInput: { amount: 200 },
        riskLevel: "medium",
        status: "rejected",
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    await raw.db.insert(connectorConnections).values({
      id: randomUUID(),
      tenantId,
      provider: "shopify",
      shopDomain: "batch-shop.myshopify.com",
      accessTokenEncrypted: Buffer.from([1, 2, 3]),
      scopes: ["read_orders"],
      status: "active",
    });
    await raw.db.insert(tenantAgentOverrides).values({
      tenantId,
      agentId: "refund-review-agent",
      model: "anthropic/claude-opus-4-8",
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
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db
        .delete(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${id}`);
      await raw.db
        .delete(tenantAgentOverrides)
        .where(sql`${tenantAgentOverrides.tenantId} = ${id}`);
      await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("GET /dashboard/tickets — tenant-scoped + paginated", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/tickets")).json()) as {
      totalRows: number;
      rows: ReadonlyArray<{ id: string; subject: string | null }>;
    };
    expect(body.totalRows).toBe(3); // excludes other tenant's ticket X
    expect(body.rows.map((r) => r.id)).not.toContain(ticketX);
  });

  it("GET /dashboard/tickets?q= — case-insensitive search over subject, summary, scenario", async () => {
    if (!raw) return;
    const ids = async (path: string) =>
      (
        (await (await get(path)).json()) as {
          rows: ReadonlyArray<{ id: string }>;
        }
      ).rows.map((r) => r.id);

    // scenario match
    expect(await ids("/dashboard/tickets?q=where_is_order")).toEqual([ticketA]);
    // subject match, case-insensitive ("Ticket B")
    expect(await ids("/dashboard/tickets?q=ticket+b")).toEqual([ticketB]);
    // summary match (ticketC's seeded summary)
    expect(await ids("/dashboard/tickets?q=widget")).toEqual([ticketC]);
    // order-number match (ticketB's seeded shopify order name "#1001")
    expect(await ids("/dashboard/tickets?q=1001")).toEqual([ticketB]);

    // a broad term narrows totalRows yet stays tenant-scoped (no ticketX)
    const broad = (await (await get("/dashboard/tickets?q=ticket")).json()) as {
      totalRows: number;
      rows: ReadonlyArray<{ id: string }>;
    };
    expect(broad.totalRows).toBe(3);
    expect(broad.rows.map((r) => r.id)).not.toContain(ticketX);
  });

  it("GET /dashboard/tickets/:id — detail with timeline + approvals", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/tickets/${ticketB}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: {
        id: string;
        status: string;
        manualStatusTargets: ReadonlyArray<string>;
      };
      auditEntries: ReadonlyArray<unknown>;
      approvals: ReadonlyArray<{ tool: string }>;
    };
    expect(body.ticket.id).toBe(ticketB);
    expect(body.ticket.status).toBe("waiting_for_approval");
    // The hand-settable status targets are matrix-derived server-side and never
    // include the ticket's own current status (the SPA renders these directly).
    expect(Array.isArray(body.ticket.manualStatusTargets)).toBe(true);
    expect(body.ticket.manualStatusTargets).not.toContain("waiting_for_approval");
    expect(body.auditEntries).toHaveLength(1);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.tool).toBe("refund.create");
  });

  it("GET /dashboard/tickets/:id — 404 for another tenant's ticket", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/tickets/${ticketX}`)).status).toBe(404);
  });

  it("GET /dashboard/tickets/:id/conversation-thread — reports a ticket without a thread", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/tickets/${ticketA}/conversation-thread`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "unavailable",
      reason: "no_thread",
    });
  });

  it("GET /dashboard/tickets/:id/conversation-thread — 404 for another tenant's ticket", async () => {
    if (!raw) return;
    expect(
      (await get(`/dashboard/tickets/${ticketX}/conversation-thread`)).status,
    ).toBe(404);
  });

  it("GET /dashboard/tickets/:id/conversation-thread — requires dashboard auth", async () => {
    if (!raw) return;
    expect(
      (
        await get(`/dashboard/tickets/${ticketA}/conversation-thread`, {})
      ).status,
    ).toBe(401);
  });

  it("GET /dashboard/tickets/:id/events — audit rows since cursor", async () => {
    if (!raw) return;
    const body = (await (await get(`/dashboard/tickets/${ticketA}/events?since=0`)).json()) as {
      events: ReadonlyArray<{ action: string }>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.action)).toEqual([
      "event.received",
      "tool.invoked",
    ]);
  });

  it("GET /dashboard/tickets/:id/events — 404 for another tenant's ticket", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/tickets/${ticketX}/events`)).status).toBe(404);
  });

  it("GET /dashboard/approvals — pending by default, with facets", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/approvals")).json()) as {
      totalRows: number;
      rows: ReadonlyArray<{ id: string }>;
      statusCounts: Record<string, number>;
      toolFacets: ReadonlyArray<string>;
      agentFacets: ReadonlyArray<string>;
    };
    expect(body.totalRows).toBe(1); // only the pending row
    expect(body.rows[0]?.id).toBe(approvalId);
    expect(body.statusCounts["pending"]).toBe(1);
    expect(body.statusCounts["approved"]).toBe(1);
    expect(body.statusCounts["rejected"]).toBe(1);
    expect(body.toolFacets).toContain("refund.create");
    expect(body.agentFacets).toContain("refund-review-agent");
  });

  it("GET /dashboard/approvals — multi-select status + risk filters", async () => {
    if (!raw) return;
    const ids = async (path: string) =>
      (
        (await (await get(path)).json()) as {
          rows: ReadonlyArray<{ id: string }>;
        }
      ).rows.map((r) => r.id);

    // Repeated status keys OR together (the "Any status" select-all sends all
    // three): approved + rejected returns exactly those two rows.
    const both = await ids("/dashboard/approvals?status=approved&status=rejected");
    expect(both).toHaveLength(2);
    expect(both).toContain(approvedApprovalId);
    expect(both).toContain(rejectedApprovalId);

    // A second filter narrows by AND: of those two, only the low-risk one stays.
    expect(
      await ids("/dashboard/approvals?status=approved&status=rejected&risk=low"),
    ).toEqual([approvedApprovalId]);

    // Repeated risk keys OR: medium + high spans the rejected and pending rows.
    const risky = await ids("/dashboard/approvals?status=pending&status=rejected&risk=medium&risk=high");
    expect(risky).toHaveLength(2);
    expect(risky).toContain(approvalId);
    expect(risky).toContain(rejectedApprovalId);
  });

  it("GET /dashboard/approvals/:id — detail, 404 cross-tenant", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/approvals/${approvalId}`)).status).toBe(200);
    const other = await fetch(`${baseUrl}/dashboard/approvals/${approvalId}`, {
      headers: dashboardAuthHeaders(otherOrgId),
    });
    expect(other.status).toBe(404);
  });

  it("GET /dashboard/audit — scoped, with action filter", async () => {
    if (!raw) return;
    const all = (await (await get("/dashboard/audit")).json()) as {
      totalRows: number;
    };
    expect(all.totalRows).toBe(3); // tenant1 only

    const filtered = (await (await get("/dashboard/audit?action=tool.invoked")).json()) as {
      totalRows: number;
      rows: ReadonlyArray<{ action: string }>;
    };
    expect(filtered.totalRows).toBe(1);
    expect(filtered.rows[0]?.action).toBe("tool.invoked");
  });

  it("GET /dashboard/connections — tenant-scoped connector list", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/connections")).json()) as {
      connections: ReadonlyArray<{
        provider: string;
        shopDomain: string | null;
        status: string;
        scopes: ReadonlyArray<string>;
      }>;
    };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]?.provider).toBe("shopify");
    expect(body.connections[0]?.shopDomain).toBe("batch-shop.myshopify.com");
    expect(body.connections[0]?.status).toBe("active");
    expect(body.connections[0]?.scopes).toContain("read_orders");
    expect(body.connections[0]).toHaveProperty("metadata");
  });

  it("GET /dashboard/tickets/:id/shopify — panels (null entities + shop domain)", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/tickets/${ticketA}/shopify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customer: unknown;
      order: unknown;
      shopDomain: string | null;
    };
    // ticketA has empty context -> no Shopify lookups, so customer/order null.
    expect(body.customer).toBeNull();
    expect(body.order).toBeNull();
    expect(body.shopDomain).toBe("batch-shop.myshopify.com");
  });

  it("GET /dashboard/tickets/:id/shopify — 404 cross-tenant", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/tickets/${ticketX}/shopify`)).status).toBe(404);
  });

  it("GET /dashboard/usage — returns llm.decision rows in window", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/usage")).json()) as {
      rows: ReadonlyArray<{ occurredAt: string; details: unknown }>;
    };
    // ticketB's seeded audit row is an llm.decision (the only one for tenant1).
    expect(body.rows).toHaveLength(1);
    expect(typeof body.rows[0]?.occurredAt).toBe("string");
  });

  it("GET /dashboard/agent-overrides — per-agent overrides", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/agent-overrides")).json()) as {
      overrides: ReadonlyArray<{
        agentId: string;
        model: string | null;
        systemPrompt: string | null;
        toolPermissions: Record<string, string> | null;
      }>;
    };
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]).toEqual({
      agentId: "refund-review-agent",
      model: "anthropic/claude-opus-4-8",
      systemPrompt: null,
      toolPermissions: null,
    });
  });

  it("rejects without a token (401)", async () => {
    if (!raw) return;
    const res = await fetch(`${baseUrl}/dashboard/tickets`, {
      headers: {},
    });
    expect(res.status).toBe(401);
  });
});
