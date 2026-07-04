import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  abandonReplyDelivery,
  tickets,
  enqueueReplyDelivery,
  getActiveReplyDeliveryForTicket,
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

// POST /dashboard/tickets/:id/retry-send — the manual "Retry sending email"
// button: requeue the failed reply-delivery so the worker sweep re-sends it.
describeIfDb("apps/api — /dashboard/tickets/:id/retry-send (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const workosUser = `user_${randomUUID()}`;

  const ticketFailed = randomUUID();
  const ticketVisible = randomUUID();
  const ticketClean = randomUUID();
  const ticketOther = randomUUID();

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

  const mkTicket = (id: string, owner: string) => ({
    id,
    tenantId: owner,
    channel: "email",
    status: "human_takeover",
    currentAgentId: "order-status-agent",
    mailbox: "support@shop.com",
  });

  const seedFailedDelivery = async (ticketId: string, owner: string) => {
    await enqueueReplyDelivery(raw!.db, {
      tenantId: owner,
      ticketId,
      agentId: "order-status-agent",
      tool: "conversation.reply",
      mailbox: "support@shop.com",
      draftId: `d-${ticketId}`,
      draft: { draftId: `d-${ticketId}`, threadId: "t1", bodyText: "hi", to: [] },
      error: "ConversationSendFailed",
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    });
    const active = await getActiveReplyDeliveryForTicket(raw!.db, ticketId);
    await abandonReplyDelivery(raw!.db, active!.id, "cap reached");
  };

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "w", workosOrganizationId: orgId },
      { id: otherTenantId, name: "w2", workosOrganizationId: otherOrgId },
    ]);
    await raw.db
      .insert(tickets)
      .values([
        mkTicket(ticketFailed, tenantId),
        mkTicket(ticketVisible, tenantId),
        mkTicket(ticketClean, tenantId),
        mkTicket(ticketOther, otherTenantId),
      ]);
    await seedFailedDelivery(ticketFailed, tenantId);
    await seedFailedDelivery(ticketVisible, tenantId);
    await seedFailedDelivery(ticketOther, otherTenantId);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("ticket detail exposes the active failed delivery even without a risk flag", async () => {
    if (!raw) return;
    const res = await get(`/dashboard/tickets/${ticketVisible}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ticket: { context: unknown };
      activeReplyDelivery: null | {
        ticketId: string;
        status: string;
        draftId: string;
        lastError: string | null;
      };
    };
    const context = (body.ticket.context ?? {}) as Record<string, unknown>;
    expect(context["riskFlags"] ?? []).not.toContain("reply_delivery_failed");
    expect(body.activeReplyDelivery).toMatchObject({
      ticketId: ticketVisible,
      status: "abandoned",
      draftId: `d-${ticketVisible}`,
      lastError: "cap reached",
    });
  });

  it("requeues the abandoned delivery (pending, due now, fresh attempts)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/tickets/${ticketFailed}/retry-send`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("queued");

    const row = (
      await raw.db
        .select()
        .from(replyDeliveries)
        .where(eq(replyDeliveries.ticketId, ticketFailed))
    )[0]!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("404s when the ticket has no failed delivery", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/tickets/${ticketClean}/retry-send`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "no_failed_delivery",
    );
  });

  it("is tenant-scoped: cannot retry another workspace's ticket", async () => {
    if (!raw) return;
    // Acting as `orgId`/tenantId, target the OTHER tenant's ticket.
    const res = await post(`/dashboard/tickets/${ticketOther}/retry-send`);
    expect(res.status).toBe(404);
    // The other tenant's row is untouched (still abandoned).
    const row = (
      await raw.db
        .select()
        .from(replyDeliveries)
        .where(eq(replyDeliveries.ticketId, ticketOther))
    )[0]!;
    expect(row.status).toBe("abandoned");
  });
});
