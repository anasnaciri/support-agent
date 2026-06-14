import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { startServer, type ServerHandle } from "../server.js";
import type { ApiConfig } from "../bootstrap.js";

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

  // Audit S5 — /installed reflected the raw ?shop= and decoded ?host=
  // params into HTML. The page is unauthenticated, so this was a clean
  // reflected XSS on the api origin.
  describe("GET /installed — reflected XSS hardening (audit S5)", () => {
    it("drops a script payload in ?shop=", async () => {
      const payload = "<img src=x onerror=alert(document.domain)>";
      const res = await fetch(
        `${baseUrl}/installed?shop=${encodeURIComponent(payload)}`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("<img");
      expect(body).not.toContain("onerror");
    });

    it("renders a valid myshopify domain", async () => {
      const res = await fetch(
        `${baseUrl}/installed?shop=test-store.myshopify.com`,
      );
      const body = await res.text();
      expect(body).toContain("test-store.myshopify.com");
    });

    it("rejects a crafted ?host= that passes the prefix check but breaks out of the href", async () => {
      const evil = Buffer.from(
        'admin.shopify.com/"><script>alert(1)</script>',
        "utf8",
      ).toString("base64");
      const res = await fetch(`${baseUrl}/installed?host=${evil}`);
      const body = await res.text();
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain('"><');
    });

    it("still links a legitimate admin host", async () => {
      const good = Buffer.from(
        "admin.shopify.com/store/test-store",
        "utf8",
      ).toString("base64");
      const res = await fetch(`${baseUrl}/installed?host=${good}`);
      const body = await res.text();
      expect(body).toContain(
        'href="https://admin.shopify.com/store/test-store"',
      );
    });
  });

  // Audit S2 — the emailed approval link is a GET; scanners follow GETs.
  // The GET must verify-and-render only; the page's form POSTs to decide.
  describe("approval links — GET never mutates (audit S2)", () => {
    it("GET with a garbage token renders the invalid-link page without touching state", async () => {
      const res = await fetch(
        `${baseUrl}/approvals/00000000-0000-0000-0000-000000000001/approve?token=garbage`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("can't be used");
    });
  });

  // Audit S11 — security headers on every response.
  describe("security headers (audit S11)", () => {
    it("sets X-Content-Type-Options and frame protections", async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBeTruthy();
    });

    it("ships a Content-Security-Policy on HTML pages", async () => {
      const res = await fetch(`${baseUrl}/installed`);
      expect(res.headers.get("content-security-policy")).toBeTruthy();
    });
  });
});
