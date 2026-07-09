import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeDbClient,
  tenants,
  ticketAttachments,
  tickets,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — /dashboard ticket attachment endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ticketId = randomUUID();
  const foreignTicketId = randomUUID();

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

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("png-body"),
  ]);

  const upload = (
    path: string,
    body: Buffer,
    contentType: string,
    org = orgId,
  ) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: dashboardAuthHeaders(org, { "content-type": contentType }),
      body,
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "Acme", workosOrganizationId: orgId },
      { id: otherTenantId, name: "Other", workosOrganizationId: otherOrgId },
    ]);
    await raw.db.insert(tickets).values([
      {
        id: ticketId,
        tenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "support-triage",
        context: {},
      },
      {
        id: foreignTicketId,
        tenantId: otherTenantId,
        channel: "email",
        status: "human_takeover",
        currentAgentId: "support-triage",
        context: {},
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
      .delete(ticketAttachments)
      .where(sql`${ticketAttachments.tenantId} IN (${tenantId}, ${otherTenantId})`);
    await raw.db
      .delete(tickets)
      .where(sql`${tickets.tenantId} IN (${tenantId}, ${otherTenantId})`);
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantId}, ${otherTenantId})`);
    await raw.close();
  });

  it("uploads a PNG, indexes it, and lists it back — storage key never leaves the server", async () => {
    const res = await upload(
      `/dashboard/tickets/${ticketId}/attachments?filename=damage.png`,
      png,
      "image/png",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment: Record<string, unknown>;
    };
    expect(body.attachment["filename"]).toBe("damage.png");
    expect(body.attachment["contentType"]).toBe("image/png");
    expect(body.attachment["source"]).toBe("merchant");
    expect(typeof body.attachment["id"]).toBe("string");
    expect(body.attachment["storageKey"]).toBeUndefined();

    const list = await fetch(
      `${baseUrl}/dashboard/tickets/${ticketId}/attachments`,
      { headers: dashboardAuthHeaders(orgId) },
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      attachments: ReadonlyArray<Record<string, unknown>>;
    };
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0]!["id"]).toBe(body.attachment["id"]);
  });

  it("rejects bytes that don't match the declared content type", async () => {
    const res = await upload(
      `/dashboard/tickets/${ticketId}/attachments?filename=fake.png`,
      Buffer.from("%PDF-1.7 not a png"),
      "image/png",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "content_mismatch" });
  });

  it("rejects types off the allowlist", async () => {
    const res = await upload(
      `/dashboard/tickets/${ticketId}/attachments?filename=run.exe`,
      png,
      "application/octet-stream",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_type" });
  });

  it("404s when the ticket belongs to another workspace", async () => {
    const res = await upload(
      `/dashboard/tickets/${foreignTicketId}/attachments?filename=x.png`,
      png,
      "image/png",
    );
    expect(res.status).toBe(404);
  });
});
