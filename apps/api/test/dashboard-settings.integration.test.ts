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
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  ConnectorCredentialStore,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { startServer, type ServerHandle } from "../src/server.js";
import { signInstallGrant, verifyInstallGrant } from "../src/install-grant.js";
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
  const legalFreshOrgId = `org_${randomUUID().slice(0, 8)}`;
  const noLegalOrgId = `org_${randomUUID().slice(0, 8)}`;
  const blockedOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const noLegalTenantId = randomUUID();
  const blockedTenantId = randomUUID();
  const createdTenantIds: string[] = [
    tenantId,
    otherTenantId,
    noLegalTenantId,
    blockedTenantId,
  ];

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
    google: {
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: "http://localhost/google/auth/callback",
      pubsubTopic: null,
      pushToken: null,
    },
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
    provider: "gmail" | "google_sheets" | "shopify" | "outlook" | "imap",
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
      {
        id: tenantId,
        name: "Acme",
        workosOrganizationId: orgId,
        settings: {
          legalAcceptance: {
            dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
            dpaVersion: DPA_VERSION,
            acceptedAt: "2026-06-04T12:00:00.000Z",
            acceptedByUserId: "11111111-1111-1111-1111-111111111111",
          },
        },
      },
      { id: otherTenantId, name: "Other", workosOrganizationId: otherOrgId },
      {
        id: noLegalTenantId,
        name: "No Legal",
        workosOrganizationId: noLegalOrgId,
      },
      {
        id: blockedTenantId,
        name: "Blocked Legal",
        workosOrganizationId: blockedOrgId,
      },
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

  it("GET /dashboard/settings returns resolved settings (defaults applied)", async () => {
    const res = await get("/dashboard/settings", otherOrgId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refundPolicy: {
        currencyCode: string;
        denyAboveMinorUnits: number;
        mode: string;
      };
      retentionDays: number;
      supplierEscalationSheet: unknown;
      notificationEmail: unknown;
      legalAcceptance: unknown;
    };
    expect(body.refundPolicy.currencyCode).toBe("USD");
    expect(body.refundPolicy.denyAboveMinorUnits).toBe(50000);
    expect(body.refundPolicy.mode).toBe("thresholds");
    expect(body.retentionDays).toBe(730);
    expect(body.supplierEscalationSheet).toBeNull();
    expect(body.legalAcceptance).toBeNull();
  });

  // ---- Onboarding ----

  it("POST /dashboard/onboarding creates a tenant for the org (idempotent)", async () => {
    const res = await post(
      "/dashboard/onboarding",
      {
        name: "Fresh Co",
        notificationEmail: "ops@fresh.co",
        legalAccepted: true,
      },
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
      {
        name: "Fresh Co",
        notificationEmail: "ops@fresh.co",
        legalAccepted: true,
      },
      freshOrgId,
    );
    const againBody = (await again.json()) as {
      tenantId: string;
      alreadyExisted: boolean;
    };
    expect(againBody.alreadyExisted).toBe(true);
    expect(againBody.tenantId).toBe(body.tenantId);

    const [row] = await raw!.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, body.tenantId))
      .limit(1);
    const legal = (row?.settings as { legalAcceptance?: unknown })
      ?.legalAcceptance as {
      dataProcessingNoticeVersion?: string;
      dpaVersion?: string;
      acceptedAt?: string;
      acceptedByUserId?: string | null;
    };
    expect(legal.dataProcessingNoticeVersion).toBe(
      DATA_PROCESSING_NOTICE_VERSION,
    );
    expect(legal.dpaVersion).toBe(DPA_VERSION);
    expect(legal.acceptedAt).toMatch(/T/);
  });

  it("POST /dashboard/onboarding requires legal acceptance", async () => {
    const res = await post(
      "/dashboard/onboarding",
      { name: "Legal Fresh Co", notificationEmail: "ops@legal-fresh.co" },
      legalFreshOrgId,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
  });

  it("POST /dashboard/onboarding 400s on a short name / bad email", async () => {
    const a = await post(
      "/dashboard/onboarding",
      { name: "x", notificationEmail: "ops@fresh.co", legalAccepted: true },
      `org_${randomUUID().slice(0, 8)}`,
    );
    expect(a.status).toBe(400);
    const b = await post(
      "/dashboard/onboarding",
      {
        name: "Valid Name",
        notificationEmail: "nope",
        legalAccepted: true,
      },
      `org_${randomUUID().slice(0, 8)}`,
    );
    expect(b.status).toBe(400);
  });

  it("POST /dashboard/legal-acceptance records acceptance for an existing tenant", async () => {
    const res = await post(
      "/dashboard/legal-acceptance",
      {},
      noLegalOrgId,
      headers(noLegalOrgId, {
        "x-user-id": "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await raw!.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, noLegalTenantId))
      .limit(1);
    const legal = (row?.settings as { legalAcceptance?: unknown })
      ?.legalAcceptance as {
      dataProcessingNoticeVersion?: string;
      dpaVersion?: string;
      acceptedByUserId?: string | null;
    };
    expect(legal.dataProcessingNoticeVersion).toBe(
      DATA_PROCESSING_NOTICE_VERSION,
    );
    expect(legal.dpaVersion).toBe(DPA_VERSION);
    expect(legal.acceptedByUserId).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
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

  // ---- Agent system prompt override ----

  it("POST /dashboard/agents/:id/system-prompt sets + clears a custom prompt", async () => {
    if (!raw) return;
    const set = await post("/dashboard/agents/support-triage/system-prompt", {
      systemPrompt: "Always greet customers as Acme.",
    });
    expect(set.status).toBe(200);
    const [row] = await raw.db
      .select({ systemPrompt: tenantAgentOverrides.systemPrompt })
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, "support-triage"),
        ),
      )
      .limit(1);
    expect(row?.systemPrompt).toBe("Always greet customers as Acme.");

    const clear = await post(
      "/dashboard/agents/support-triage/system-prompt/clear",
    );
    expect(clear.status).toBe(200);
    const after = await raw.db
      .select({ agentId: tenantAgentOverrides.agentId })
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, "support-triage"),
        ),
      );
    expect(after.length).toBe(0);
  });

  it("POST /dashboard/agents/:id/system-prompt 404s unknown agent; blank body clears", async () => {
    const unknown = await post("/dashboard/agents/nope/system-prompt", {
      systemPrompt: "x",
    });
    expect(unknown.status).toBe(404);
    // Blank/whitespace prompt is treated as a clear (idempotent → 200, no row).
    const blank = await post(
      "/dashboard/agents/order-status-agent/system-prompt",
      { systemPrompt: "   " },
    );
    expect(blank.status).toBe(200);
    if (!raw) return;
    const after = await raw.db
      .select({ agentId: tenantAgentOverrides.agentId })
      .from(tenantAgentOverrides)
      .where(
        and(
          eq(tenantAgentOverrides.tenantId, tenantId),
          eq(tenantAgentOverrides.agentId, "order-status-agent"),
        ),
      );
    expect(after.length).toBe(0);
  });

  it("system prompt and model override coexist; clearing one keeps the other", async () => {
    if (!raw) return;
    const agentId = "damaged-product-agent";
    const selectRow = () =>
      raw.db
        .select({
          model: tenantAgentOverrides.model,
          systemPrompt: tenantAgentOverrides.systemPrompt,
        })
        .from(tenantAgentOverrides)
        .where(
          and(
            eq(tenantAgentOverrides.tenantId, tenantId),
            eq(tenantAgentOverrides.agentId, agentId),
          ),
        )
        .limit(1);

    expect(
      (
        await post(`/dashboard/agents/${agentId}/model`, {
          model: "anthropic/claude-opus-4-8",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(`/dashboard/agents/${agentId}/system-prompt`, {
          systemPrompt: "Be kind.",
        })
      ).status,
    ).toBe(200);
    const [both] = await selectRow();
    expect(both?.model).toBe("anthropic/claude-opus-4-8");
    expect(both?.systemPrompt).toBe("Be kind.");

    // Clearing the model must NOT wipe the system prompt.
    expect(
      (await post(`/dashboard/agents/${agentId}/model/clear`)).status,
    ).toBe(200);
    const [afterModelClear] = await selectRow();
    expect(afterModelClear?.model).toBeNull();
    expect(afterModelClear?.systemPrompt).toBe("Be kind.");

    // Clearing the prompt now empties the row entirely.
    expect(
      (await post(`/dashboard/agents/${agentId}/system-prompt/clear`)).status,
    ).toBe(200);
    const after = await selectRow();
    expect(after.length).toBe(0);
  });

  it("GET /dashboard/agent-overrides includes the system prompt", async () => {
    const agentId = "missing-package-agent";
    expect(
      (
        await post(`/dashboard/agents/${agentId}/system-prompt`, {
          systemPrompt: "House style.",
        })
      ).status,
    ).toBe(200);
    const res = await get("/dashboard/agent-overrides");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overrides: ReadonlyArray<{
        agentId: string;
        model: string | null;
        systemPrompt: string | null;
      }>;
    };
    const row = body.overrides.find((o) => o.agentId === agentId);
    expect(row?.systemPrompt).toBe("House style.");
    await post(`/dashboard/agents/${agentId}/system-prompt/clear`);
  });

  // ---- LLM credential ----

  it("POST /dashboard/llm rejects tenants without current legal acceptance", async () => {
    const res = await post(
      "/dashboard/llm",
      {
        provider: "openrouter",
        apiKey: "sk-or-v1-abcdefgh",
      },
      blockedOrgId,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
  });

  it("GET /google/install rejects tenants without current legal acceptance", async () => {
    // Install now requires a signed grant; mint a valid one for the blocked
    // tenant so the request reaches the legal check (which must reject it).
    const grant = encodeURIComponent(
      signInstallGrant(
        "k",
        { tenantId: blockedTenantId, provider: "gmail" },
        Date.now() + 600_000,
      ),
    );
    const res = await fetch(`${baseUrl}/google/install?grant=${grant}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
  });

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
      mode: "always_deny",
    });
    expect(res.status).toBe(200);
    const [row] = await raw.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const policy = (
      row?.settings as {
        refundPolicy?: { currencyCode?: string; mode?: string };
      }
    )?.refundPolicy;
    expect(policy?.currencyCode).toBe("USD");
    expect(policy?.mode).toBe("always_deny");
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

  // ---- Connector connect (authenticated install grant, 5th-audit #2) ----

  it("POST /dashboard/connect/:provider mints a grant bound to the session's tenant", async () => {
    const res = await post("/dashboard/connect/shopify");
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain("/shopify/install?grant=");
    const grant = new URL(url).searchParams.get("grant");
    const decoded = verifyInstallGrant("k", grant ?? "");
    // The tenant is derived from the authenticated session (x-org-id →
    // tenant), NOT supplied by the client.
    expect(decoded).toEqual({ tenantId, provider: "shopify" });
  });

  it("POST /dashboard/connect/:provider mints a google grant for gmail", async () => {
    const res = await post("/dashboard/connect/gmail");
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain("/google/install?grant=");
    const decoded = verifyInstallGrant(
      "k",
      new URL(url).searchParams.get("grant") ?? "",
    );
    expect(decoded).toEqual({ tenantId, provider: "gmail" });
  });

  it("POST /dashboard/connect/:provider 400s on an unknown provider", async () => {
    const res = await post("/dashboard/connect/stripe");
    expect(res.status).toBe(400);
  });

  it("POST /dashboard/connect/:provider rejects an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/dashboard/connect/shopify`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  // ---- Connector disconnect ----

  it("POST /dashboard/connections/:provider/disconnect revokes provider-side AND locally", async () => {
    if (!raw) return;
    await seedConnection(tenantId, "gmail", "mailbox@acme.test");
    // Disconnect now revokes the grant PROVIDER-SIDE (5th-audit #3). Stub
    // fetch so the test doesn't hit Google; record that it was called.
    const originalFetch = globalThis.fetch;
    const calls: Array<string> = [];
    // Stub ONLY the external provider calls; pass the test's own HTTP
    // requests to the in-process api server through to the real fetch.
    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("googleapis.com")) {
        calls.push(u);
        return new Response("", { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    let body: { revoked: number; providerRevoked: number };
    try {
      const res = await post("/dashboard/connections/gmail/disconnect");
      expect(res.status).toBe(200);
      body = (await res.json()) as typeof body;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(body.revoked).toBe(1);
    // Provider-side revoke was attempted (Gmail watch-stop + token revoke).
    expect(body.providerRevoked).toBe(1);
    expect(calls.some((u) => u.includes("oauth2.googleapis.com/revoke"))).toBe(
      true,
    );
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

  it("POST /dashboard/connections/outlook/disconnect revokes the row locally", async () => {
    if (!raw) return;
    await seedConnection(tenantId, "outlook", "ops@acme.test");
    // Outlook has no client-callable provider-side revoke, so this must NOT
    // reach any external host — fail loudly if it tries.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("microsoft") || u.includes("graph") || u.includes("login")) {
        throw new Error(`unexpected provider call during outlook disconnect: ${u}`);
      }
      return originalFetch(url, init);
    }) as typeof fetch;
    let body: { revoked: number; providerRevoked: number };
    try {
      const res = await post("/dashboard/connections/outlook/disconnect");
      expect(res.status).toBe(200);
      body = (await res.json()) as typeof body;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(body.revoked).toBe(1);
    const active = await raw.db
      .select({ id: connectorConnections.id })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, tenantId),
          eq(connectorConnections.provider, "outlook"),
          eq(connectorConnections.status, "active"),
        ),
      );
    expect(active.length).toBe(0);
  });

  it("POST /dashboard/connections/imap/disconnect revokes the row locally", async () => {
    if (!raw) return;
    await seedConnection(tenantId, "imap", "support@acme.test");
    const res = await post("/dashboard/connections/imap/disconnect");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number };
    expect(body.revoked).toBe(1);
    const active = await raw.db
      .select({ id: connectorConnections.id })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.tenantId, tenantId),
          eq(connectorConnections.provider, "imap"),
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
