import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  auditLog,
  cases,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// cases/approvals/audit read endpoints (Path B, slices 2-4).
describeIfDb("apps/api — /dashboard read endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-batch-token";
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const caseA = randomUUID(); // resolved, 2 audit rows, 0 approvals
  const caseB = randomUUID(); // waiting_for_approval, 1 audit row, 1 pending approval
  const caseC = randomUUID(); // human_takeover
  const caseX = randomUUID(); // OTHER tenant
  const approvalId = randomUUID();

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
    dashboardApiToken: token,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const mkCase = (
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
    caseId: string,
    owner: string,
    action: string,
    actorType: string,
  ) => ({ tenantId: owner, caseId, action, actorType, details: {} });

  const auth = { authorization: `Bearer ${token}`, "x-org-id": orgId };
  const get = (path: string, headers: Record<string, string> = auth) =>
    fetch(`${baseUrl}${path}`, { headers });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "batch", workosOrganizationId: orgId },
      { id: otherTenantId, name: "batch-other", workosOrganizationId: otherOrgId },
    ]);
    await raw.db.insert(cases).values([
      mkCase(caseA, tenantId, "resolved", {
        subject: "Case A",
        category: "where_is_order",
        resolvedAt: new Date(),
      }),
      mkCase(caseB, tenantId, "waiting_for_approval", { subject: "Case B" }),
      mkCase(caseC, tenantId, "human_takeover", { subject: "Case C" }),
      mkCase(caseX, otherTenantId, "resolved", { subject: "Case X" }),
    ]);
    await raw.db.insert(auditLog).values([
      mkAudit(caseA, tenantId, "event.received", "system"),
      mkAudit(caseA, tenantId, "tool.invoked", "agent"),
      mkAudit(caseB, tenantId, "llm.decision", "agent"),
      mkAudit(caseX, otherTenantId, "event.received", "system"),
    ]);
    await raw.db.insert(approvals).values({
      id: approvalId,
      tenantId,
      caseId: caseB,
      agentId: "refund-review-agent",
      tool: "refund.create",
      proposedInput: { amount: 500 },
      riskLevel: "high",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("GET /dashboard/cases — tenant-scoped + paginated", async () => {
    if (!raw) return;
    const body = (await (await get("/dashboard/cases")).json()) as {
      totalRows: number;
      rows: ReadonlyArray<{ id: string; subject: string | null }>;
    };
    expect(body.totalRows).toBe(3); // excludes other tenant's case X
    expect(body.rows.map((r) => r.id)).not.toContain(caseX);
  });

  it("GET /dashboard/cases/:id — detail with timeline + approvals", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/cases/${caseB}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      case: { id: string; status: string };
      auditEntries: ReadonlyArray<unknown>;
      approvals: ReadonlyArray<{ tool: string }>;
    };
    expect(body.case.id).toBe(caseB);
    expect(body.case.status).toBe("waiting_for_approval");
    expect(body.auditEntries).toHaveLength(1);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.tool).toBe("refund.create");
  });

  it("GET /dashboard/cases/:id — 404 for another tenant's case", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/cases/${caseX}`)).status).toBe(404);
  });

  it("GET /dashboard/cases/:id/events — audit rows since cursor", async () => {
    if (!raw) return;
    const body = (await (await get(`/dashboard/cases/${caseA}/events?since=0`)).json()) as {
      events: ReadonlyArray<{ action: string }>;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.action)).toEqual([
      "event.received",
      "tool.invoked",
    ]);
  });

  it("GET /dashboard/cases/:id/events — 404 for another tenant's case", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/cases/${caseX}/events`)).status).toBe(404);
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
    expect(body.totalRows).toBe(1);
    expect(body.rows[0]?.id).toBe(approvalId);
    expect(body.statusCounts["pending"]).toBe(1);
    expect(body.toolFacets).toContain("refund.create");
    expect(body.agentFacets).toContain("refund-review-agent");
  });

  it("GET /dashboard/approvals/:id — detail, 404 cross-tenant", async () => {
    if (!raw) return;
    expect((await get(`/dashboard/approvals/${approvalId}`)).status).toBe(200);
    const other = await fetch(`${baseUrl}/dashboard/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${token}`, "x-org-id": otherOrgId },
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

  it("rejects without a token (401)", async () => {
    if (!raw) return;
    const res = await fetch(`${baseUrl}/dashboard/cases`, {
      headers: { "x-org-id": orgId },
    });
    expect(res.status).toBe(401);
  });
});
