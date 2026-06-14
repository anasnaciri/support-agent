import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  approvals,
  auditLog,
  caseStateTransitions,
  cases,
  connectorConnections,
  makeDbClient,
  tenantAgentOverrides,
  tenants,
} from "@support-agent/db";
import { encrypt } from "@support-agent/services";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
  decisionUuidFor,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Account deletion — dashboard self-service + admin paths.
describeIfDb("apps/api — account deletion (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const dashToken = "del-dash-token";
  const adminToken = "del-admin-token";

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const workosUser = `user_${randomUUID()}`;
  const managerId = decisionUuidFor(workosUser);

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
    adminApiToken: adminToken,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const post = (path: string, h: Record<string, string>) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: h });

  const dashHeaders = (org: string) =>
    dashboardAuthHeaders(org, {}, workosUser);
  const adminHeaders = (token: string) => ({
    authorization: `Bearer ${token}`,
  });

  // Seed one tenant with a row in every tenant-scoped table.
  const seedTenant = async (id: string, org: string) => {
    const caseId = randomUUID();
    const caseId2 = randomUUID();
    await raw!.db.insert(tenants).values({
      id,
      name: `T-${org}`,
      workosOrganizationId: org,
      settings: { notificationEmail: `owner-${org}@example.com` },
    });
    await raw!.db.insert(cases).values([
      { id: caseId, tenantId: id, channel: "email", status: "new", currentAgentId: "support-triage" },
      { id: caseId2, tenantId: id, channel: "email", status: "resolved", currentAgentId: "support-triage" },
    ]);
    await raw!.db.insert(caseStateTransitions).values({
      caseId,
      fromStatus: "new",
      toStatus: "resolved",
    });
    await raw!.db.insert(approvals).values({
      id: randomUUID(),
      tenantId: id,
      caseId,
      agentId: "refund-review-agent",
      tool: "conversation.reply",
      proposedInput: { bodyText: "x" },
      riskLevel: "medium",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await raw!.db.insert(auditLog).values({
      tenantId: id,
      caseId,
      actorType: "system",
      actorId: "test",
      action: "case.created",
      details: {},
    });
    // Real AES-GCM ciphertext (under cfg.encryptionKey) so the B1
    // grant-capture path decrypts it cleanly before the wipe instead of
    // failing-soft. The deletion still wipes it either way.
    await raw!.db.insert(connectorConnections).values({
      id: randomUUID(),
      tenantId: id,
      provider: "shopify",
      shopDomain: `${org}.myshopify.com`,
      accessTokenEncrypted: encrypt(cfg.encryptionKey, "shpat_live_token"),
      apiVersion: "2025-01",
      scopes: ["read_orders"],
    });
    await raw!.db.insert(tenantAgentOverrides).values({
      tenantId: id,
      agentId: "support-triage",
      model: "anthropic/claude-x",
    });
  };

  const counts = async (id: string) => {
    const c = async (q: Promise<Array<unknown>>) => (await q).length;
    return {
      tenants: await c(raw!.db.select().from(tenants).where(eq(tenants.id, id))),
      cases: await c(raw!.db.select().from(cases).where(eq(cases.tenantId, id))),
      approvals: await c(
        raw!.db.select().from(approvals).where(eq(approvals.tenantId, id)),
      ),
      audit: await c(
        raw!.db.select().from(auditLog).where(eq(auditLog.tenantId, id)),
      ),
      connectors: await c(
        raw!.db
          .select()
          .from(connectorConnections)
          .where(eq(connectorConnections.tenantId, id)),
      ),
      overrides: await c(
        raw!.db
          .select()
          .from(tenantAgentOverrides)
          .where(eq(tenantAgentOverrides.tenantId, id)),
      ),
    };
  };

  const adminAuditRows = async (id: string) =>
    raw!.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.targetTenantId, id));

  beforeAll(async () => {
    if (!raw) return;
    await seedTenant(tenantA, orgA);
    await seedTenant(tenantB, orgB);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantA, tenantB]) {
      await raw.db
        .delete(tenantAgentOverrides)
        .where(eq(tenantAgentOverrides.tenantId, id));
      await raw.db
        .delete(connectorConnections)
        .where(eq(connectorConnections.tenantId, id));
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${id}`);
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
      await raw.db
        .delete(adminAuditLog)
        .where(sql`${adminAuditLog.targetTenantId} = ${id}`);
    }
    await raw.close();
  });

  it("admin delete with a bad token → 401, no mutation", async () => {
    if (!raw) return;
    const res = await post(
      `/admin/tenants/${tenantB}/delete`,
      adminHeaders("wrong"),
    );
    expect(res.status).toBe(401);
    expect((await counts(tenantB)).tenants).toBe(1);
  });

  it("admin delete of an unknown tenant → 404 tenant_not_found", async () => {
    if (!raw) return;
    const res = await post(
      `/admin/tenants/${randomUUID()}/delete`,
      adminHeaders(adminToken),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "tenant_not_found",
    );
  });

  it("dashboard self-service delete wipes tenant A and leaves tenant B intact", async () => {
    if (!raw) return;
    const res = await post("/dashboard/account/delete", dashHeaders(orgA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      deletedCases: number;
      deletedConnectorRows: number;
      workosOrganizationId: string | null;
      cleanupEnqueued: boolean;
    };
    expect(body.kind).toBe("deleted");
    expect(body.deletedCases).toBe(2);
    expect(body.deletedConnectorRows).toBe(1);
    expect(body.workosOrganizationId).toBe(orgA);
    expect(body.cleanupEnqueued).toBe(true);

    // Every tenant-A row is gone (transitions/timers/image_hashes cascade
    // from the cases delete; overrides cascade from the tenant delete).
    expect(await counts(tenantA)).toEqual({
      tenants: 0,
      cases: 0,
      approvals: 0,
      audit: 0,
      connectors: 0,
      overrides: 0,
    });
    // Tenant B is untouched.
    expect(await counts(tenantB)).toEqual({
      tenants: 1,
      cases: 2,
      approvals: 1,
      audit: 1,
      connectors: 1,
      overrides: 1,
    });

    // A surviving platform-admin audit record exists even though the tenant's
    // own audit_log was wiped (re-audit #2). Self-service → actor tenant_self.
    const adminAudit = await adminAuditRows(tenantA);
    expect(adminAudit).toHaveLength(1);
    expect(adminAudit[0]!.action).toBe("tenant.deleted");
    expect(adminAudit[0]!.actor).toBe("tenant_self");
  });

  it("a second dashboard delete (tenant A already gone) → 403 no tenant for org", async () => {
    if (!raw) return;
    const res = await post("/dashboard/account/delete", dashHeaders(orgA));
    expect(res.status).toBe(403);
  });

  it("admin delete of tenant B wipes it", async () => {
    if (!raw) return;
    const res = await post(
      `/admin/tenants/${tenantB}/delete`,
      adminHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("deleted");
    expect(await counts(tenantB)).toEqual({
      tenants: 0,
      cases: 0,
      approvals: 0,
      audit: 0,
      connectors: 0,
      overrides: 0,
    });

    // Surviving admin-audit record for the admin-initiated deletion (#2).
    const adminAudit = await adminAuditRows(tenantB);
    expect(adminAudit).toHaveLength(1);
    expect(adminAudit[0]!.action).toBe("tenant.deleted");
    expect(adminAudit[0]!.actor).toBe("admin");
  });
});
