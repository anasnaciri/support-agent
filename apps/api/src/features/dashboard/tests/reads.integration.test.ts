import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  approvals,
  cases,
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
    const approvalCaseId = randomUUID();
    await raw.db.insert(cases).values([
      mkCase(randomUUID(), tenantId, "resolved", { resolvedAt: now }),
      mkCase(randomUUID(), tenantId, "human_takeover", {
        subject: "Where is my order?",
        category: "where_is_order",
      }),
      mkCase(approvalCaseId, tenantId, "waiting_for_approval"),
      mkCase(randomUUID(), tenantId, "in_progress"),
      // Different tenant — must NOT leak into tenant1's counts.
      mkCase(randomUUID(), otherTenantId, "resolved", { resolvedAt: now }),
    ]);

    await raw.db.insert(approvals).values({
      id: randomUUID(),
      tenantId,
      caseId: approvalCaseId,
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
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
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
      takeoverCases: ReadonlyArray<{ subject: string | null }>;
    };

    expect(body.statusCounts["resolved"]).toBe(1); // not 2 — other tenant excluded
    expect(body.statusCounts["human_takeover"]).toBe(1);
    expect(body.statusCounts["waiting_for_approval"]).toBe(1);
    expect(body.statusCounts["in_progress"]).toBe(1);
    expect(body.resolvedTodayCount).toBe(1);
    expect(body.pendingApprovals).toHaveLength(1);
    expect(body.pendingApprovals[0]?.tool).toBe("refund.create");
    expect(body.takeoverCases).toHaveLength(1);
    expect(body.takeoverCases[0]?.subject).toBe("Where is my order?");
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
