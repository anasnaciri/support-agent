import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

// Smoke coverage that needs no Postgres. `startServer` builds its DB layers
// lazily (postgres-js only connects on the first query), so the routes that
// never touch the store — `/healthz`, the generated OpenAPI document, and
// the not-found fallback — all resolve without a live database. This keeps a
// fast, always-on signal even when the DB-gated integration suite is skipped.
describe("apps/api — server smoke (no DB)", () => {
  const cfg: ApiConfig = {
    port: 0,
    databaseUrl: "postgres://user:pass@localhost:5432/unused",
    encryptionKey: randomBytes(32),
    stateSigningKey: "smoke-state-key",
    shopify: {
      clientId: "smoke-client",
      clientSecret: "smoke-secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2026-04",
    },
    google: null,
    approvalSigningKey: "smoke-approval-key",
    dashboardBaseUrl: null,
  };

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("GET /healthz returns 200 ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /openapi.json serves the generated OpenAPI document", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    expect(doc.openapi).toBeTruthy();
    expect(doc.paths).toBeTruthy();
    // The route table is reflected into the spec.
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toContain("/healthz");
    expect(paths).toContain("/shopify/install");
  });

  it("GET /legal/data-processing serves the merchant data notice + DPA", async () => {
    const res = await fetch(`${baseUrl}/legal/data-processing`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Data Processing Notice");
    expect(body).toContain("Data Processing Addendum");
    expect(body).toContain("customer name");
    expect(body).toContain("customer email");
    expect(body).toContain("OpenRouter");
  });

  it("returns 404 {error:not_found} for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
