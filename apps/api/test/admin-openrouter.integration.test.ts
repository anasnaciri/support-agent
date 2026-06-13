import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  encrypt,
} from "@support-agent/services";
import {
  accountOpenrouterCredentials,
  adminAuditLog,
  connectorConnections,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — admin OpenRouter credentials (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const encryptionKey = randomBytes(32);
  const adminToken = "admin-openrouter-token";
  const org = `org_${randomUUID()}`;
  const staleOrg = `org_${randomUUID()}`;
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const staleWorkspace = randomUUID();
  const currentLegal = {
    dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
    dpaVersion: DPA_VERSION,
    acceptedAt: "2026-06-13T00:00:00.000Z",
    acceptedByUserId: "user_admin_test",
  };
  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey,
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
    dashboardApiToken: "dash",
    adminApiToken: adminToken,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const auth = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
  const request = (
    path: string,
    method: "GET" | "PUT" | "DELETE",
    body?: unknown,
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: auth,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      {
        id: workspaceA,
        name: "Workspace A",
        workosOrganizationId: org,
        settings: { legalAcceptance: currentLegal },
      },
      {
        id: workspaceB,
        name: "Workspace B",
        workosOrganizationId: org,
        settings: { legalAcceptance: currentLegal },
      },
      {
        id: staleWorkspace,
        name: "Stale workspace",
        workosOrganizationId: staleOrg,
        settings: {
          legalAcceptance: { ...currentLegal, dpaVersion: "2020-01-01" },
        },
      },
    ]);
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(adminAuditLog)
      .where(
        sql`${adminAuditLog.targetTenantId} IN (${workspaceA}, ${workspaceB}, ${staleWorkspace})`,
      );
    await raw.db
      .delete(connectorConnections)
      .where(
        sql`${connectorConnections.tenantId} IN (${workspaceA}, ${workspaceB}, ${staleWorkspace})`,
      );
    await raw.db
      .delete(accountOpenrouterCredentials)
      .where(
        sql`${accountOpenrouterCredentials.organizationId} IN (${org}, ${staleOrg})`,
      );
    await raw.db
      .delete(tenants)
      .where(
        sql`${tenants.id} IN (${workspaceA}, ${workspaceB}, ${staleWorkspace})`,
      );
    await raw.close();
  });

  it("requires admin authentication", async () => {
    const res = await fetch(`${baseUrl}/admin/accounts/${org}`);
    expect(res.status).toBe(401);
  });

  it("sets and rotates an encrypted account key without returning the secret", async () => {
    const secret = "sk-or-v1-account-secret";
    const put = await request(`/admin/accounts/${org}/openrouter`, "PUT", {
      apiKey: secret,
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(secret);

    const [stored] = await raw!.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, org));
    expect(stored?.status).toBe("active");
    expect(stored?.apiKeyEncrypted.includes(Buffer.from(secret))).toBe(false);

    const detail = await request(`/admin/accounts/${org}`, "GET");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      organizationId: org,
      openrouter: { status: "active" },
    });

    const audits = await raw!.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "openrouter.account_set"));
    expect(audits.some((row) => row.action === "openrouter.account_set")).toBe(
      true,
    );
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it("refuses an account key when any workspace legal acceptance is stale", async () => {
    const res = await request(`/admin/accounts/${staleOrg}/openrouter`, "PUT", {
      apiKey: "sk-or-v1-stale",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
  });

  it("sets and revokes a workspace override, leaving the account key active", async () => {
    const secret = "sk-or-v1-workspace-secret";
    await raw!.db.insert(connectorConnections).values({
      id: randomUUID(),
      tenantId: workspaceB,
      provider: "anthropic",
      shopDomain: "default",
      accessTokenEncrypted: encrypt(encryptionKey, "sk-ant-replaced"),
    });
    const put = await request(
      `/admin/tenants/${workspaceB}/openrouter`,
      "PUT",
      { apiKey: secret },
    );
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(secret);

    const active = await raw!.db
      .select()
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, workspaceB),
          eq(connectorConnections.provider, "openrouter"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0]!.accessTokenEncrypted.includes(Buffer.from(secret))).toBe(
      false,
    );
    const activeAnthropic = await raw!.db
      .select()
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, workspaceB),
          eq(connectorConnections.provider, "anthropic"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(activeAnthropic).toHaveLength(0);

    const revoked = await request(
      `/admin/tenants/${workspaceB}/openrouter`,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    const [account] = await raw!.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, org));
    expect(account?.status).toBe("active");
    const detail = await request(`/admin/tenants/${workspaceB}`, "GET");
    expect(await detail.json()).toMatchObject({
      llm: { effectiveProvider: "openrouter", effectiveSource: "account" },
    });
  });

  it("refuses a workspace override without current legal acceptance", async () => {
    const res = await request(
      `/admin/tenants/${staleWorkspace}/openrouter`,
      "PUT",
      { apiKey: "sk-or-v1-stale-workspace" },
    );
    expect(res.status).toBe(403);
  });

  it("revokes the account key without changing workspace rows", async () => {
    const res = await request(`/admin/accounts/${org}/openrouter`, "DELETE");
    expect(res.status).toBe(200);
    const [account] = await raw!.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(eq(accountOpenrouterCredentials.organizationId, org));
    expect(account?.status).toBe("revoked");
  });
});
