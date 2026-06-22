import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  abandonReplyDelivery,
  cases,
  enqueueReplyDelivery,
  getActiveReplyDeliveryForCase,
  makeDbClient,
  replyDeliveries,
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

// POST /dashboard/cases/:id/retry-send — the manual "Retry sending email"
// button: requeue the failed reply-delivery so the worker sweep re-sends it.
describeIfDb("apps/api — /dashboard/cases/:id/retry-send (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const workosUser = `user_${randomUUID()}`;

  const caseFailed = randomUUID();
  const caseVisible = randomUUID();
  const caseClean = randomUUID();
  const caseOther = randomUUID();

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

  const post = (path: string, owner = orgId) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: dashboardAuthHeaders(
        owner,
        { "content-type": "application/json" },
        workosUser,
      ),
      body: "{}",
    });

  const get = (path: string, owner = orgId) =>
    fetch(`${baseUrl}${path}`, {
      headers: dashboardAuthHeaders(owner, {}, workosUser),
    });

  const mkCase = (id: string, owner: string) => ({
    id,
    tenantId: owner,
    channel: "email",
    status: "human_takeover",
    currentAgentId: "order-status-agent",
    mailbox: "support@shop.com",
  });

  const seedFailedDelivery = async (caseId: string, owner: string) => {
    await enqueueReplyDelivery(raw!.db, {
      tenantId: owner,
      caseId,
      agentId: "order-status-agent",
      tool: "conversation.reply",
      mailbox: "support@shop.com",
      draftId: `d-${caseId}`,
      draft: { draftId: `d-${caseId}`, threadId: "t1", bodyText: "hi", to: [] },
      error: "ConversationSendFailed",
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });
    const active = await getActiveReplyDeliveryForCase(raw!.db, caseId);
    await abandonReplyDelivery(raw!.db, active!.id, "cap reached");
  };

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "w", workosOrganizationId: orgId },
      { id: otherTenantId, name: "w2", workosOrganizationId: otherOrgId },
    ]);
    await raw.db
      .insert(cases)
      .values([
        mkCase(caseFailed, tenantId),
        mkCase(caseVisible, tenantId),
        mkCase(caseClean, tenantId),
        mkCase(caseOther, otherTenantId),
      ]);
    await seedFailedDelivery(caseFailed, tenantId);
    await seedFailedDelivery(caseVisible, tenantId);
    await seedFailedDelivery(caseOther, otherTenantId);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("case detail exposes the active failed delivery even without a risk flag", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/cases/${caseVisible}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      case: { context: unknown };
      activeReplyDelivery: null | {
        caseId: string;
        status: string;
        draftId: string;
        lastError: string | null;
      };
    };
    const context = (body.case.context ?? {}) as Record<string, unknown>;
    expect(context["riskFlags"] ?? []).not.toContain("reply_delivery_failed");
    expect(body.activeReplyDelivery).toMatchObject({
      caseId: caseVisible,
      status: "abandoned",
      draftId: `d-${caseVisible}`,
      lastError: "cap reached",
    });
  });

  it("requeues the abandoned delivery (pending, due now, fresh attempts)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseFailed}/retry-send`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("queued");

    const row = (
      await raw.db
        .select()
        .from(replyDeliveries)
        .where(eq(replyDeliveries.caseId, caseFailed))
    )[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("404s when the case has no failed delivery", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseClean}/retry-send`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "no_failed_delivery",
    );
  });

  it("is tenant-scoped: cannot retry another workspace's case", async () => {
    if (!raw) return;
    // Acting as `orgId`/tenantId, target the OTHER tenant's case.
    const res = await post(`/dashboard/cases/${caseOther}/retry-send`);
    expect(res.status).toBe(404);
    // The other tenant's row is untouched (still abandoned).
    const row = (
      await raw.db
        .select()
        .from(replyDeliveries)
        .where(eq(replyDeliveries.caseId, caseOther))
    )[0]!;
    expect(row.status).toBe("abandoned");
  });
});
