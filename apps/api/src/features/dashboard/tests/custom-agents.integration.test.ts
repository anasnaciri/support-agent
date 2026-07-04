import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeDbClient, tenantCustomAgents, tenants } from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// End-to-end create → get → update → delete for merchant-authored custom
// agents, plus validation 4xx and tenant isolation, against a real server + DB.
describeIfDb("apps/api — /dashboard custom-agents (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = `user_${randomUUID()}`;
  const userB = `user_${randomUUID()}`;

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

  const post = (
    path: string,
    body: unknown,
    org = orgA,
    user = userA,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: dashboardAuthHeaders(
        org,
        { "content-type": "application/json" },
        user,
      ),
      body: JSON.stringify(body),
    });

  const get = (path: string, org = orgA, user = userA): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      headers: dashboardAuthHeaders(org, {}, user),
    });

  const validBody = (over: Record<string, unknown> = {}) => ({
    name: "Returns Concierge",
    description: "Handles returns.",
    instructions: "Be warm. Look up the order before promising anything.",
    model: "google/gemini-3.5-flash",
    // Non-scope-gated tools so the happy path needs no connector; the
    // scope-miss ticket below uses refund.create deliberately.
    tools: ["conversation.reply", "knowledge.search"],
    handoffs: [],
    callableFrom: ["support-triage"],
    permissionOverrides: { "conversation.reply": "ask" },
    whenToUse: "When the customer wants a return.",
    maxTurnsPerTick: 8,
    status: "active",
    ...over,
  });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantA, name: "A", workosOrganizationId: orgA },
      { id: tenantB, name: "B", workosOrganizationId: orgB },
    ]);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(tenantCustomAgents)
      .where(sql`${tenantCustomAgents.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
    await raw.close();
  });

  it("creates → gets → updates → deletes a custom agent", async () => {
    if (!raw) return;
    const createRes = await post("/dashboard/custom-agents", validBody());
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      agentId: string;
      name: string;
      isCustom?: boolean;
    };
    expect(created.agentId.startsWith("custom:")).toBe(true);
    expect(created.name).toBe("Returns Concierge");

    // Appears in the catalog as a custom agent.
    const catalog = (await (await get("/dashboard/catalog")).json()) as {
      agents: Array<{ id: string; isCustom: boolean }>;
    };
    expect(
      catalog.agents.some((a) => a.id === created.agentId && a.isCustom),
    ).toBe(true);

    // GET by id returns the editable view with raw instructions.
    const getRes = await get(`/dashboard/custom-agents/${created.agentId}`);
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as { instructions: string };
    expect(view.instructions).toContain("Be warm");

    // Update renames it.
    const updRes = await post(
      `/dashboard/custom-agents/${created.agentId}`,
      validBody({ name: "Returns Desk" }),
    );
    expect(updRes.status).toBe(200);
    expect(((await updRes.json()) as { name: string }).name).toBe(
      "Returns Desk",
    );

    // Delete removes it.
    const delRes = await post(
      `/dashboard/custom-agents/${created.agentId}/delete`,
      {},
    );
    expect(delRes.status).toBe(200);
    expect((await get(`/dashboard/custom-agents/${created.agentId}`)).status).toBe(
      404,
    );
  });

  it("rejects an empty name (400 name_required)", async () => {
    if (!raw) return;
    const res = await post("/dashboard/custom-agents", validBody({ name: " " }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("name_required");
  });

  it("rejects a non-assignable tool (400 invalid_tool)", async () => {
    if (!raw) return;
    const res = await post(
      "/dashboard/custom-agents",
      validBody({ tools: ["agent.handoff"], permissionOverrides: {} }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_tool");
  });

  it("rejects a scope-gated tool the tenant can't satisfy (400 missing_connector_scope)", async () => {
    if (!raw) return;
    const res = await post(
      "/dashboard/custom-agents",
      validBody({ tools: ["refund.create"], permissionOverrides: {} }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_connector_scope",
    );
  });

  it("rejects a duplicate name in the same workspace (409 duplicate_name)", async () => {
    if (!raw) return;
    const first = await post(
      "/dashboard/custom-agents",
      validBody({ name: "Concierge" }),
    );
    expect(first.status).toBe(200);
    const dup = await post(
      "/dashboard/custom-agents",
      validBody({ name: "concierge" }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe(
      "duplicate_name",
    );
  });

  it("isolates tenants: B cannot read A's custom agent (404)", async () => {
    if (!raw) return;
    const created = (await (
      await post("/dashboard/custom-agents", validBody({ name: "A-only" }))
    ).json()) as { agentId: string };
    const res = await get(
      `/dashboard/custom-agents/${created.agentId}`,
      orgB,
      userB,
    );
    expect(res.status).toBe(404);
  });

  it("requires authentication (401 without a valid token)", async () => {
    if (!raw) return;
    const res = await fetch(`${baseUrl}/dashboard/custom-agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer no" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });
});
