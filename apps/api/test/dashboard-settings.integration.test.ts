import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { and, eq, sql } from "drizzle-orm";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  connectorConnections,
  makeDbClient,
  tenantAgentOverrides,
  tenants,
} from "@support-agent/db";
import { ConnectorCredentialStore } from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Path B slice 8a — dashboard catalog/models/tenant reads + settings writes.
describeIfDb("apps/api — /dashboard settings endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-settings-token";
  const encryptionKey = randomBytes(32);

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const noTenantOrgId = `org_${randomUUID().slice(0, 8)}`;
  const freshOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const createdTenantIds: string[] = [tenantId, otherTenantId];

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
    dashboardApiToken: token,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (org: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    "x-org-id": org,
    "content-type": "application/json",
    ...extra,
  });
  const get = (path: string, org = orgId, h?: Record<string, string>) =>
    fetch(`${baseUrl}${path}`, { headers: h ?? headers(org) });
  const post = (
    path: string,
    body: unknown = {},
    org = orgId,
    h?: Record<string, string>,
  ) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: h ?? headers(org),
      body: JSON.stringify(body),
    });

  const seedConnection = (
    tid: string,
    provider: "gmail" | "google_sheets" | "shopify",
    shopDomain: string,
  ): Promise<void> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId: TenantId(tid),
            provider,
            shopDomain,
            accessToken: `tok_${provider}`,
            scopes: [],
          });
        }),
        ConnectorCredentialStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "Acme", workosOrganizationId: orgId },
      { id: otherTenantId, name: "Other", workosOrganizationId: otherOrgId },
    ]);
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of createdTenantIds) {
      await raw.db
        .delete(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${id}`);
      await raw.db
        .delete(tenantAgentOverrides)
        .where(sql`${tenantAgentOverrides.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  // ---- Reads ----

  it("GET /dashboard/catalog returns agents + tools", async () => {
    const res = await get("/dashboard/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ id: string }>;
      tools: Array<{ name: string }>;
    };
    expect(body.agents.some((a) => a.id === "support-triage")).toBe(true);
    expect(body.tools.some((t) => t.name === "conversation.reply")).toBe(true);
  });

  it("GET /dashboard/catalog 401s on a bad token", async () => {
    const res = await get("/dashboard/catalog", orgId, {
      authorization: "Bearer wrong",
      "x-org-id": orgId,
    });
    expect(res.status).toBe(401);
  });

  it("GET /dashboard/models reports disconnected with no LLM credential", async () => {
    const res = await get("/dashboard/models", otherOrgId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      provider: string | null;
      entries: unknown[];
    };
    expect(body.connected).toBe(false);
    expect(body.provider).toBeNull();
    expect(body.entries).toEqual([]);
  });

  it("GET /dashboard/tenant returns the org's tenant", async () => {
    const res = await get("/dashboard/tenant");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { tenantId: string; name: string } | null;
    };
    expect(body.tenant).toEqual({ tenantId, name: "Acme" });
  });

  it("GET /dashboard/tenant returns null when the org has no tenant", async () => {
    const res = await get("/dashboard/tenant", noTenantOrgId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tenant: unknown }).tenant).toBeNull();
  });

  // ---- Onboarding ----

  it("POST /dashboard/onboarding creates a tenant for the org (idempotent)", async () => {
    const res = await post(
      "/dashboard/onboarding",
      { name: "Fresh Co", notificationEmail: "ops@fresh.co" },
      freshOrgId,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      alreadyExisted: boolean;
    };
    expect(body.alreadyExisted).toBe(false);
    expect(body.tenantId).toBeTruthy();
    createdTenantIds.push(body.tenantId);

    // Re-submit → idempotent, same tenant id.
    const again = await post(
      "/dashboard/onboarding",
      { name: "Fresh Co", notificationEmail: "ops@fresh.co" },
      freshOrgId,
    );
    const againBody = (await again.json()) as {
      tenantId: string;
      alreadyExisted: boolean;
    };
    expect(againBody.alreadyExisted).toBe(true);
    expect(againBody.tenantId).toBe(body.tenantId);
  });

  it("POST /dashboard/onboarding 400s on a short name / bad email", async () => {
    const a = await post(
      "/dashboard/onboarding",
      { name: "x", notificationEmail: "ops@fresh.co" },
      `org_${randomUUID().slice(0, 8)}`,
    );
    expect(a.status).toBe(400);
    const b = await post(
      "/dashboard/onboarding",
      { name: "Valid Name", notificationEmail: "nope" },
      `org_${randomUUID().slice(0, 8)}`,
    );
    expect(b.status).toBe(400);
  });

  // ---- Agent model override ----

  it("POST /dashboard/agents/:id/model sets + clears an override", async () => {
    if (!raw) return;
    const set = await post("/dashboard/agents/order-status-agent/model", {
      model: "anthropic/claude-opus-4-8",
    });
    expect(set.status).toBe(200);
    const [row] = await raw.db
      .select({ model: tenantAgentOverrides.model })
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, "order-status-agent"),
        ),
      )
      .limit(1);
    expect(row?.model).toBe("anthropic/claude-opus-4-8");

    const clear = await post(
      "/dashboard/agents/order-status-agent/model/clear",
    );
    expect(clear.status).toBe(200);
    const after = await raw.db
      .select({ model: tenantAgentOverrides.model })
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, "order-status-agent"),
        ),
      );
    expect(after.length).toBe(0);
  });

  it("POST /dashboard/agents/:id/model 404s for an unknown agent, 400 on empty model", async () => {
    const unknown = await post("/dashboard/agents/nope/model", {
      model: "x",
    });
    expect(unknown.status).toBe(404);
    const empty = await post("/dashboard/agents/order-status-agent/model", {
      model: "",
    });
    expect(empty.status).toBe(400);
  });

  // ---- LLM credential ----

  it("POST /dashboard/llm connects then revokes a credential", async () => {
    if (!raw) return;
    const connect = await post("/dashboard/llm", {
      provider: "openrouter",
      apiKey: "sk-or-v1-abcdefgh",
      baseURL: "https://openrouter.ai/api/v1",
    });
    expect(connect.status).toBe(200);
    const active = await raw.db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, tenantId),
          eq(connectorConnections.provider, "openrouter"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(active.length).toBe(1);

    const revoke = await post("/dashboard/llm/revoke");
    expect(revoke.status).toBe(200);
    const stillActive = await raw.db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, tenantId),
          eq(connectorConnections.provider, "openrouter"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(stillActive.length).toBe(0);
  });

  it("POST /dashboard/llm 400s on a bad provider / short key", async () => {
    const badProvider = await post("/dashboard/llm", {
      provider: "cohere",
      apiKey: "sk-or-v1-abcdefgh",
    });
    expect(badProvider.status).toBe(400);
    const shortKey = await post("/dashboard/llm", {
      provider: "openrouter",
      apiKey: "short",
    });
    expect(shortKey.status).toBe(400);
  });

  // ---- Refund policy ----

  it("POST /dashboard/refund-policy writes the tenant setting", async () => {
    if (!raw) return;
    const res = await post("/dashboard/refund-policy", {
      currencyCode: "usd",
      askAboveMinorUnits: 2500,
      denyAboveMinorUnits: 20000,
    });
    expect(res.status).toBe(200);
    const [row] = await raw.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const policy = (row?.settings as { refundPolicy?: { currencyCode?: string } })
      ?.refundPolicy;
    expect(policy?.currencyCode).toBe("USD");
  });

  it("POST /dashboard/refund-policy 400s on bad currency / amount / ordering", async () => {
    expect(
      (
        await post("/dashboard/refund-policy", {
          currencyCode: "US",
          askAboveMinorUnits: 1,
          denyAboveMinorUnits: 2,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/dashboard/refund-policy", {
          currencyCode: "USD",
          askAboveMinorUnits: -1,
          denyAboveMinorUnits: 2,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/dashboard/refund-policy", {
          currencyCode: "USD",
          askAboveMinorUnits: 5000,
          denyAboveMinorUnits: 100,
        })
      ).status,
    ).toBe(400);
  });

  // ---- Supplier-escalation sheet ----

  it("POST /dashboard/supplier-sheet sets then clears the sheet", async () => {
    if (!raw) return;
    const set = await post("/dashboard/supplier-sheet", {
      spreadsheetId: "1AbCdEfG",
      range: "Escalations!A:F",
      description: "warehouse log",
    });
    expect(set.status).toBe(200);
    const [row] = await raw.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const sheet = (
      row?.settings as {
        supplierEscalationSheet?: { spreadsheetId?: string } | null;
      }
    )?.supplierEscalationSheet;
    expect(sheet?.spreadsheetId).toBe("1AbCdEfG");

    const clear = await post("/dashboard/supplier-sheet/clear");
    expect(clear.status).toBe(200);
    const [after] = await raw.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    expect(
      (after?.settings as { supplierEscalationSheet?: unknown })
        ?.supplierEscalationSheet ?? null,
    ).toBeNull();
  });

  it("POST /dashboard/supplier-sheet 400s on a bad range / missing id", async () => {
    expect(
      (
        await post("/dashboard/supplier-sheet", {
          spreadsheetId: "1AbCdEfG",
          range: "A:F",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/dashboard/supplier-sheet", {
          spreadsheetId: "",
          range: "Sheet1!A:F",
        })
      ).status,
    ).toBe(400);
  });

  // ---- Connector disconnect ----

  it("POST /dashboard/connections/:provider/disconnect revokes active rows", async () => {
    if (!raw) return;
    await seedConnection(tenantId, "gmail", "mailbox@acme.test");
    const res = await post("/dashboard/connections/gmail/disconnect");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revoked: number }).revoked).toBe(1);
    const active = await raw.db
      .select({ id: connectorConnections.id })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, tenantId),
          eq(connectorConnections.provider, "gmail"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(active.length).toBe(0);
  });

  it("POST /dashboard/connections/:provider/disconnect 400s on an unknown provider", async () => {
    const res = await post("/dashboard/connections/stripe/disconnect");
    expect(res.status).toBe(400);
  });

  // ---- Auth edges ----

  it("503 when the dashboard token is not configured", async () => {
    const noTokenCfg = { ...cfg, dashboardApiToken: "" } as ApiConfig;
    const h = await startServer(noTokenCfg);
    try {
      const res = await fetch(
        `http://localhost:${h.port}/dashboard/catalog`,
        { headers: headers(orgId) },
      );
      expect(res.status).toBe(503);
    } finally {
      await h.close();
    }
  });
});
