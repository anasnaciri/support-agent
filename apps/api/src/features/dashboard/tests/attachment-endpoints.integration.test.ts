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

  // Previews: the thread renders an <img> against a short-lived signed URL.
  // The blob is never streamed through the API, and the storage key it is
  // minted from never reaches the client.
  describe("GET /dashboard/tickets/:id/attachments/:attachmentId/url", () => {
    const uploadOne = async (filename: string): Promise<string> => {
      const res = await upload(
        `/dashboard/tickets/${ticketId}/attachments?filename=${filename}`,
        png,
        "image/png",
      );
      const body = (await res.json()) as { attachment: { id: string } };
      return body.attachment.id;
    };

    it("mints a short-TTL signed URL for an attachment on this ticket", async () => {
      const id = await uploadOne("preview.png");
      const res = await fetch(
        `${baseUrl}/dashboard/tickets/${ticketId}/attachments/${id}/url`,
        { headers: dashboardAuthHeaders(orgId) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        url: string;
        expiresInSeconds: number;
        contentType: string;
        filename: string;
      };
      expect(body.url).toContain("memory://"); // BlobStorageTest's presign shape
      expect(body.expiresInSeconds).toBeGreaterThan(0);
      expect(body.expiresInSeconds).toBeLessThanOrEqual(300);
      expect(body.contentType).toBe("image/png");
      expect(body.filename).toBe("preview.png");
    });

    it("404s for an attachment id from another ticket (no cross-ticket reach)", async () => {
      const id = await uploadOne("mine.png");
      // Same tenant, different ticket → the id must not resolve.
      const otherTicket = randomUUID();
      await raw!.db.insert(tickets).values({
        id: otherTicket,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "support-triage",
        context: {},
      });
      const res = await fetch(
        `${baseUrl}/dashboard/tickets/${otherTicket}/attachments/${id}/url`,
        { headers: dashboardAuthHeaders(orgId) },
      );
      expect(res.status).toBe(404);
    });

    it("404s for an unknown attachment id", async () => {
      const res = await fetch(
        `${baseUrl}/dashboard/tickets/${ticketId}/attachments/${randomUUID()}/url`,
        { headers: dashboardAuthHeaders(orgId) },
      );
      expect(res.status).toBe(404);
    });

    // A non-UUID id used to reach the `uuid` column cast and surface as a
    // Postgres error → 502 "our fault" + an error log line per request. It is
    // simply an id that resolves to nothing.
    it("404s (not 502) for a malformed attachment id", async () => {
      for (const bogus of ["not-a-uuid", "..%2F..%2Fetc%2Fpasswd", "1"]) {
        const res = await fetch(
          `${baseUrl}/dashboard/tickets/${ticketId}/attachments/${bogus}/url`,
          { headers: dashboardAuthHeaders(orgId) },
        );
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not_found" });
      }
    });

    it("404s when the ticket belongs to another workspace", async () => {
      const id = await uploadOne("mine2.png");
      const res = await fetch(
        `${baseUrl}/dashboard/tickets/${foreignTicketId}/attachments/${id}/url`,
        { headers: dashboardAuthHeaders(otherOrgId) },
      );
      expect(res.status).toBe(404);
    });
  });
});
