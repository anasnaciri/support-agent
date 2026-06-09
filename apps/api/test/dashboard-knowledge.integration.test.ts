import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  makeDbClient,
  tenantKnowledgeDocuments,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — /dashboard/knowledge endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "dash-knowledge-token";

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgCap = `org_${randomUUID().slice(0, 8)}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantCap = randomUUID();
  const tenantIds = [tenantA, tenantB, tenantCap];

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
      clientId: "g",
      clientSecret: "gs",
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
  const get = (path: string, org = orgA, h?: Record<string, string>) =>
    fetch(`${baseUrl}${path}`, { headers: h ?? headers(org) });
  const post = (path: string, body: unknown = {}, org = orgA) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(org),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantA, name: "KB-A", workosOrganizationId: orgA },
      { id: tenantB, name: "KB-B", workosOrganizationId: orgB },
      { id: tenantCap, name: "KB-Cap", workosOrganizationId: orgCap },
    ]);
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of tenantIds) {
      await raw.db
        .delete(tenantKnowledgeDocuments)
        .where(sql`${tenantKnowledgeDocuments.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("creates a pasted text doc, lists it, and reads it back in full", async () => {
    const created = await post("/dashboard/knowledge", {
      title: "Shipping policy",
      sourceType: "text",
      content: "We ship within 3 business days.",
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(id).toBeTruthy();

    const list = await get("/dashboard/knowledge");
    expect(list.status).toBe(200);
    const { documents } = (await list.json()) as {
      documents: Array<{ id: string; title: string; sourceType: string }>;
    };
    const row = documents.find((d) => d.id === id);
    expect(row).toMatchObject({ title: "Shipping policy", sourceType: "text" });
    expect(row).not.toHaveProperty("content");

    const detail = await get(`/dashboard/knowledge/${id}`);
    expect(detail.status).toBe(200);
    const { document } = (await detail.json()) as {
      document: { content: string };
    };
    expect(document.content).toBe("We ship within 3 business days.");
  });

  it("updates the title + content of a text doc", async () => {
    const { id } = (await (
      await post("/dashboard/knowledge", {
        title: "Old",
        sourceType: "text",
        content: "old body",
      })
    ).json()) as { id: string };

    const upd = await post(`/dashboard/knowledge/${id}`, {
      title: "New",
      content: "new body",
    });
    expect(upd.status).toBe(200);

    const { document } = (await (
      await get(`/dashboard/knowledge/${id}`)
    ).json()) as { document: { title: string; content: string } };
    expect(document).toMatchObject({ title: "New", content: "new body" });
  });

  it("deletes a doc (then 404s)", async () => {
    const { id } = (await (
      await post("/dashboard/knowledge", {
        title: "Doomed",
        sourceType: "text",
        content: "x",
      })
    ).json()) as { id: string };
    expect((await post(`/dashboard/knowledge/${id}/delete`)).status).toBe(200);
    expect((await get(`/dashboard/knowledge/${id}`)).status).toBe(404);
  });

  it("rejects resync of a text (non-URL) doc", async () => {
    const { id } = (await (
      await post("/dashboard/knowledge", {
        title: "Pasted",
        sourceType: "text",
        content: "body",
      })
    ).json()) as { id: string };
    const res = await post(`/dashboard/knowledge/${id}/resync`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "not_a_url_doc",
    );
  });

  it("rejects an empty title and oversized content", async () => {
    expect(
      (
        await post("/dashboard/knowledge", {
          title: "  ",
          sourceType: "text",
          content: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/dashboard/knowledge", {
          title: "Big",
          sourceType: "text",
          content: "x".repeat(100_001),
        })
      ).status,
    ).toBe(400);
  });

  it("blocks a URL that targets a private/loopback address (SSRF guard)", async () => {
    const res = await post("/dashboard/knowledge", {
      title: "From internal",
      sourceType: "url",
      sourceUrl: "http://127.0.0.1/admin",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("fetch_failed");
    expect(body.reason).toBe("blocked_host");
  });

  it("blocks a non-http(s) URL scheme", async () => {
    const res = await post("/dashboard/knowledge", {
      title: "FTP",
      sourceType: "url",
      sourceUrl: "ftp://example.com/policy",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason?: string }).reason).toBe(
      "blocked_scheme",
    );
  });

  it("is tenant-scoped: B cannot read/update/delete A's doc (404)", async () => {
    const { id } = (await (
      await post("/dashboard/knowledge", {
        title: "A-only",
        sourceType: "text",
        content: "secret",
      })
    ).json()) as { id: string };

    expect((await get(`/dashboard/knowledge/${id}`, orgB)).status).toBe(404);
    expect(
      (await post(`/dashboard/knowledge/${id}`, { title: "hijack" }, orgB))
        .status,
    ).toBe(404);
    expect(
      (await post(`/dashboard/knowledge/${id}/delete`, {}, orgB)).status,
    ).toBe(404);
    // A's doc survives.
    expect((await get(`/dashboard/knowledge/${id}`, orgA)).status).toBe(200);
  });

  it("404s on a malformed (non-UUID) id", async () => {
    expect((await get("/dashboard/knowledge/not-a-uuid")).status).toBe(404);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await fetch(`${baseUrl}/dashboard/knowledge`, {
      headers: { authorization: "Bearer wrong", "x-org-id": orgA },
    });
    expect(res.status).toBe(401);
  });

  it("enforces the per-tenant document cap (403)", async () => {
    if (!raw) return;
    // Seed the cap directly for speed.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tenantId: tenantCap,
      title: `Doc ${i}`,
      content: "body",
      sourceType: "text",
    }));
    await raw.db.insert(tenantKnowledgeDocuments).values(rows);
    const res = await post(
      "/dashboard/knowledge",
      { title: "One too many", sourceType: "text", content: "x" },
      orgCap,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "too_many_documents",
    );
  });
});
