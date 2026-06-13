import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { makeDbClient, tenantAgentOverrides, tenants } from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
  decisionUuidFor,
} from "./support/dashboard-auth.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Per-agent tool-permission endpoints (ask first vs auto). Exercises the guard
// rules (refund is threshold-controlled, not toggle-controlled; tools must be
// bound to the agent; only ask|allow) end-to-end against a real server + DB.
describeIfDb("apps/api — /dashboard agent tool-permission (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "tool-perm-token";
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const workosUser = `user_${randomUUID()}`;
  const managerId = decisionUuidFor(workosUser);
  const agentId = "refund-review-agent"; // binds conversation.reply + refund.create

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

  const post = (path: string, body: unknown = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: dashboardAuthHeaders(
        orgId,
        { "content-type": "application/json" },
        workosUser,
      ),
      body: JSON.stringify(body),
    });

  const overrideRow = () =>
    raw!.db
      .select()
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, agentId),
        ),
      )
      .limit(1)
      .then((r) => r[0]);

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "tp", workosOrganizationId: orgId });
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(tenantAgentOverrides)
      .where(sql`${tenantAgentOverrides.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("sets a tool permission and persists it to the override row", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/agents/${agentId}/tool-permission`, {
      tool: "conversation.reply",
      permission: "allow",
    });
    expect(res.status).toBe(200);
    expect((await overrideRow())?.toolPermissions).toEqual({
      "conversation.reply": "allow",
    });
  });

  it("clearing the only tool permission removes the row", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/agents/${agentId}/tool-permission/clear`,
      { tool: "conversation.reply" },
    );
    expect(res.status).toBe(200);
    expect(await overrideRow()).toBeUndefined();
  });

  it("rejects refund.create — it is threshold-controlled, not a toggle", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/agents/${agentId}/tool-permission`, {
      tool: "refund.create",
      permission: "allow",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "tool_not_configurable",
    );
  });

  it("rejects a tool that isn't bound to the agent", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/agents/${agentId}/tool-permission`, {
      tool: "tracking.lookup",
      permission: "allow",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "tool_not_on_agent",
    );
  });

  it("rejects an unknown agent", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/agents/not-a-real-agent/tool-permission`, {
      tool: "conversation.reply",
      permission: "allow",
    });
    expect(res.status).toBe(404);
  });

  it("rejects a permission other than ask|allow (no 'deny' via the toggle)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/agents/${agentId}/tool-permission`, {
      tool: "conversation.reply",
      permission: "deny",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_permission",
    );
  });
});
