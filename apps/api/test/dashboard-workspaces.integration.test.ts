import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { cases, makeDbClient, tenants } from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "./support/dashboard-auth.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Workspaces: one WorkOS org owns many tenant rows. `x-workspace-id` pins a
// dashboard request to one of them; without it the request resolves to the
// org's DEFAULT workspace (oldest row). A workspace the org does not own is
// a 404 — NOT 403, which the dashboard reserves for "needs onboarding".
describeIfDb("apps/api — x-workspace-id resolution (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-service-token-test";
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const foreignOrgId = `org_${randomUUID().slice(0, 8)}`;
  // Default = oldest createdAt.
  const defaultWs = randomUUID();
  const secondWs = randomUUID();
  const foreignWs = randomUUID();

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

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      {
        id: defaultWs,
        name: "ws-default",
        workosOrganizationId: orgId,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: secondWs,
        name: "ws-second",
        workosOrganizationId: orgId,
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
      {
        id: foreignWs,
        name: "ws-foreign",
        workosOrganizationId: foreignOrgId,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    await raw.db.insert(cases).values([
      {
        id: randomUUID(),
        tenantId: defaultWs,
        channel: "email",
        status: "in_progress",
        currentAgentId: "support-triage",
        subject: "default-ws-case",
      },
      {
        id: randomUUID(),
        tenantId: secondWs,
        channel: "email",
        status: "in_progress",
        currentAgentId: "support-triage",
        subject: "second-ws-case",
      },
    ]);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [defaultWs, secondWs, foreignWs]) {
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  const listCases = async (headers: Record<string, string>) => {
    const res = await fetch(`${baseUrl}/dashboard/cases`, {
      headers: dashboardAuthHeaders(orgId, headers),
    });
    return res;
  };

  it("scopes reads to the workspace named by x-workspace-id", async () => {
    if (!raw) return;
    const res = await listCases({ "x-workspace-id": secondWs });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: ReadonlyArray<{ subject: string | null }>;
    };
    expect(body.rows.map((c) => c.subject)).toEqual(["second-ws-case"]);
  });

  it("falls back to the DEFAULT (oldest) workspace without the header", async () => {
    if (!raw) return;
    const res = await listCases({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: ReadonlyArray<{ subject: string | null }>;
    };
    expect(body.rows.map((c) => c.subject)).toEqual(["default-ws-case"]);
  });

  it("404s a workspace owned by ANOTHER org (no existence leak, no onboarding bounce)", async () => {
    if (!raw) return;
    const res = await listCases({ "x-workspace-id": foreignWs });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("workspace_not_found");
  });

  it("404s an unknown (well-formed) workspace id", async () => {
    if (!raw) return;
    const res = await listCases({ "x-workspace-id": randomUUID() });
    expect(res.status).toBe(404);
  });

  it("400s a malformed workspace id instead of a Postgres cast 500", async () => {
    if (!raw) return;
    const res = await listCases({ "x-workspace-id": "not-a-uuid" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_workspace_id");
  });

  it("keeps the 403 onboarding signal for an org with zero workspaces", async () => {
    if (!raw) return;
    const res = await fetch(`${baseUrl}/dashboard/cases`, {
      headers: dashboardAuthHeaders("org_with_no_workspaces"),
    });
    expect(res.status).toBe(403);
  });
});
