import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeDbClient, tenants, tickets } from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — /dashboard blocked-senders endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ticketWithEmailId = randomUUID();
  const ticketNoEmailId = randomUUID();
  const otherTenantTicketId = randomUUID();

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
    google: {
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: "http://localhost/google/auth/callback",
      pubsubTopic: null,
      pushToken: null,
    },
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (org: string) =>
    dashboardAuthHeaders(org, { "content-type": "application/json" });
  const get = (path: string, org = orgId) =>
    fetch(`${baseUrl}${path}`, { headers: headers(org) });
  const post = (path: string, body: unknown = {}, org = orgId) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(org),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "Acme", workosOrganizationId: orgId },
      { id: otherTenantId, name: "Other", workosOrganizationId: otherOrgId },
    ]);
    await raw.db.insert(tickets).values([
      {
        id: ticketWithEmailId,
        tenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "support-triage",
        context: { customerEmail: "Jane.Spammer@Example.COM" },
      },
      {
        id: ticketNoEmailId,
        tenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "support-triage",
        context: {},
      },
      {
        id: otherTenantTicketId,
        tenantId: otherTenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "support-triage",
        context: { customerEmail: "someone@other.com" },
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
    await raw.db
      .delete(tickets)
      .where(sql`${tickets.tenantId} IN (${tenantId}, ${otherTenantId})`);
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantId}, ${otherTenantId})`);
    await raw.close();
  });

  it("GET returns empty lists for a tenant that never configured a blocklist", async () => {
    const res = await get("/dashboard/blocked-senders");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emails: [], domains: [] });
  });

  it("add classifies an address as email and a bare/at-prefixed value as domain, normalizing case", async () => {
    const r1 = await post("/dashboard/blocked-senders/add", {
      value: " USER@Spam.Com ",
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({
      ok: true,
      entry: { kind: "email", value: "user@spam.com" },
    });

    const r2 = await post("/dashboard/blocked-senders/add", {
      value: "@Newsletter.Example.Com",
    });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({
      ok: true,
      entry: { kind: "domain", value: "newsletter.example.com" },
    });

    const list = (await (await get("/dashboard/blocked-senders")).json()) as {
      emails: string[];
      domains: string[];
    };
    expect(list.emails).toEqual(["user@spam.com"]);
    expect(list.domains).toEqual(["newsletter.example.com"]);
  });

  it("adding a duplicate is a 200 no-op flagged alreadyBlocked", async () => {
    const res = await post("/dashboard/blocked-senders/add", {
      value: "user@spam.com",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, alreadyBlocked: true });
    const list = (await (await get("/dashboard/blocked-senders")).json()) as {
      emails: string[];
    };
    expect(list.emails).toEqual(["user@spam.com"]);
  });

  it("rejects an unparseable value with 400 bad_value", async () => {
    const res = await post("/dashboard/blocked-senders/add", {
      value: "not a sender",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_value" });
  });

  it("remove deletes an entry; removing an unknown value is a 200 no-op", async () => {
    const r1 = await post("/dashboard/blocked-senders/remove", {
      kind: "domain",
      value: "newsletter.example.com",
    });
    expect(r1.status).toBe(200);
    const list = (await (await get("/dashboard/blocked-senders")).json()) as {
      domains: string[];
    };
    expect(list.domains).toEqual([]);

    const r2 = await post("/dashboard/blocked-senders/remove", {
      kind: "domain",
      value: "never-there.example.com",
    });
    expect(r2.status).toBe(200);
  });

  it("block-sender adds the ticket's customer email (normalized, derived server-side)", async () => {
    const res = await post(
      `/dashboard/tickets/${ticketWithEmailId}/block-sender`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      blocked: "jane.spammer@example.com",
    });
    const list = (await (await get("/dashboard/blocked-senders")).json()) as {
      emails: string[];
    };
    expect(list.emails).toContain("jane.spammer@example.com");
  });

  it("block-sender is 409 when the ticket has no customer email", async () => {
    const res = await post(`/dashboard/tickets/${ticketNoEmailId}/block-sender`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "missing_customer_email" });
  });

  it("block-sender is 404 for another tenant's ticket", async () => {
    const res = await post(
      `/dashboard/tickets/${otherTenantTicketId}/block-sender`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an add beyond the 500-entry cap with 400 list_full", async () => {
    // Seed a full domain list directly — 500 adds over HTTP would be silly.
    const domains = Array.from({ length: 500 }, (_, i) => `spam${i}.example`);
    const json = JSON.stringify({ blockedSenders: { emails: [], domains } });
    await raw!.db.execute(
      sql`UPDATE tenants SET settings = settings || ${json}::jsonb WHERE id = ${tenantId}`,
    );
    const res = await post("/dashboard/blocked-senders/add", {
      value: "one-more.example.com",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "list_full" });
  });
});
