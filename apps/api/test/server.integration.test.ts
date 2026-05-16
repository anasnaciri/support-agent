import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  ConnectorCredentialStore,
  computeHmac,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  connectorConnections,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { Layer } from "effect";
import { startServer, type ServerHandle } from "../src/server.js";
import {
  canonicalQueryForHmac,
  signState,
  verifyState,
} from "../src/shopify-install.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — Shopify install + callback (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const encryptionKey = randomBytes(32);
  const encryptionKeyB64 = encryptionKey.toString("base64");
  const stateSigningKey = "test-state-key";
  const autoCreatedShopDomains = [
    "custom-dist-shop.myshopify.com",
    "signed-install-shop.myshopify.com",
  ] as const;

  const cfg: ApiConfig = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey,
    stateSigningKey,
    shopify: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
  };

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    if (!raw) return;
    process.env["CREDENTIAL_ENCRYPTION_KEY"] = encryptionKeyB64;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "api-integ-test" });
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(connectorConnections)
      .where(sql`${connectorConnections.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    // Sweep any auto-created tenants from signed Shopify install paths;
    // cascade on connector_connections.tenant_id cleans those rows too.
    for (const shop of autoCreatedShopDomains) {
      await raw.db
        .delete(tenants)
        .where(sql`${tenants.shopifyDomain} = ${shop}`);
    }
    await raw.close();
    globalThis.fetch = originalFetch;
  });

  it("GET /shopify/install redirects to Shopify's authorize URL", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com&tenant=${tenantId}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const u = new URL(loc!);
    expect(u.host).toBe("acme.myshopify.com");
    expect(u.pathname).toBe("/admin/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it("GET /shopify/install rejects an invalid shop", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=not-a-shop&tenant=${tenantId}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("GET /shopify/install rejects a missing tenant", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("GET /shopify/install accepts Shopify's signed install request without a tenant", async () => {
    const shop = "signed-install-shop.myshopify.com";
    const query: Record<string, string> = {
      shop,
      host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvc2lnbmVkLWluc3RhbGw",
      timestamp: "1700000004",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);

    const url = new URL(`${baseUrl}/shopify/install`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("hmac", hmac);

    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const redirect = new URL(loc!);
    expect(redirect.host).toBe(shop);
    expect(redirect.pathname).toBe("/admin/oauth/authorize");
    expect(redirect.searchParams.get("client_id")).toBe("test-client-id");
    expect(redirect.searchParams.has("scope")).toBe(false);

    const state = redirect.searchParams.get("state");
    expect(state).toBeTruthy();
    const decoded = verifyState(stateSigningKey, state!);
    expect(decoded).toBeTruthy();

    const tenantRows = await raw!.db
      .select()
      .from(tenants)
      .where(sql`${tenants.shopifyDomain} = ${shop}`);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.id).toBe(decoded!.tenantId);
  });

  it("GET /shopify/auth/callback verifies HMAC, exchanges code, and persists the token", async () => {
    // Patch global fetch so the token-exchange call (made by the API
    // server inside its own request handler) hits our mock instead of
    // the real Shopify endpoint. We restore in afterAll.
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "shpoa_test_token",
            scope: "read_orders,read_customers",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Everything else (including the test's own HTTP call) uses the
      // real fetch.
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "acme.myshopify.com";
    const state = signState(stateSigningKey, tenantId);
    const query: Record<string, string> = {
      shop,
      code: "the-code",
      state,
      timestamp: "1700000000",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);

    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    // `Accept: application/json` opts into the structured success body so
    // the test can assert on it directly; browsers (no Accept header) get
    // the 302-to-admin instead.
    const res = await fetch(cbUrl, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shop).toBe(shop);

    // The token landed in the store (encrypted; we read it back through
    // the same Live layer to decrypt).
    const fetched = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.get(TenantId(tenantId), "shopify", shop);
        }),
        ConnectorCredentialStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );
    expect(fetched.accessToken).toBe("shpoa_test_token");
    expect(fetched.scopes).toEqual(["read_orders", "read_customers"]);
    expect(fetched.apiVersion).toBe("2025-01");
  });

  it("GET /shopify/auth/callback without state (Custom Distribution) auto-creates a tenant for the shop", async () => {
    // Same global fetch mock as the prior callback test — the token
    // exchange short-circuits to a fake `shpoa_` token.
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "shpoa_custom_dist",
            scope: "read_orders,read_customers",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "custom-dist-shop.myshopify.com";
    const query: Record<string, string> = {
      shop,
      code: "the-code-cd",
      timestamp: "1700000001",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);

    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    const res = await fetch(cbUrl, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shop).toBe(shop);
    expect(typeof body.tenantId).toBe("string");

    // The tenants row was created and linked to the shop domain.
    const tenantRows = await raw!.db
      .select()
      .from(tenants)
      .where(sql`${tenants.shopifyDomain} = ${shop}`);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.id).toBe(body.tenantId);

    // connector_connections row is bound to the auto-created tenant.
    const ccRows = await raw!.db
      .select()
      .from(connectorConnections)
      .where(sql`${connectorConnections.tenantId} = ${body.tenantId}`);
    expect(ccRows).toHaveLength(1);
    expect(ccRows[0]!.shopDomain).toBe(shop);
  });

  it("a second install for the same shop reuses the same tenant (idempotent resolve)", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "shpoa_reinstall",
            scope: "read_orders,read_customers",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "custom-dist-shop.myshopify.com";
    const query: Record<string, string> = {
      shop,
      code: "the-code-cd-2",
      timestamp: "1700000002",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    const res = await fetch(cbUrl, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);

    // Still exactly one tenants row for this shop (unique index prevents
    // duplicates) and exactly one connector_connections row (the upsert
    // collapses on tenant + provider + shop).
    const tenantRows = await raw!.db
      .select()
      .from(tenants)
      .where(sql`${tenants.shopifyDomain} = ${shop}`);
    expect(tenantRows).toHaveLength(1);
    const ccRows = await raw!.db
      .select()
      .from(connectorConnections)
      .where(sql`${connectorConnections.shopDomain} = ${shop}`);
    expect(ccRows).toHaveLength(1);
  });

  it("GET /shopify/auth/callback without Accept: application/json redirects browsers to the merchant admin", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "shpoa_browser",
            scope: "read_orders",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "custom-dist-shop.myshopify.com";
    const query: Record<string, string> = {
      shop,
      code: "the-code-browser",
      timestamp: "1700000010",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    // No Accept header → browser flow → 302 redirect to our /installed
    // landing page (Shopify's documented non-embedded app pattern).
    const res = await fetch(cbUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toBe("/installed?shop=custom-dist-shop.myshopify.com");
  });

  it("GET /shopify/auth/callback echoes the Shopify `host` param into the /installed redirect", async () => {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "shpoa_host",
            scope: "read_orders",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "custom-dist-shop.myshopify.com";
    const hostB64 = Buffer.from(
      "admin.shopify.com/store/custom-dist-shop",
    ).toString("base64");
    const query: Record<string, string> = {
      shop,
      host: hostB64,
      code: "the-code-host",
      timestamp: "1700000011",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    const res = await fetch(cbUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, baseUrl);
    expect(loc.pathname).toBe("/installed");
    expect(loc.searchParams.get("shop")).toBe(shop);
    expect(loc.searchParams.get("host")).toBe(hostB64);
  });

  it("GET /installed renders the connected landing page with the shop name", async () => {
    const shop = "support-agent-test.myshopify.com";
    const hostB64 = Buffer.from(
      "admin.shopify.com/store/support-agent-test",
    ).toString("base64");
    const res = await fetch(
      `${baseUrl}/installed?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(hostB64)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Connected");
    expect(body).toContain(shop);
    expect(body).toContain(
      "https://admin.shopify.com/store/support-agent-test",
    );
  });

  it("GET /shopify/auth/callback with TAMPERED state returns 401 (does not silently fall back)", async () => {
    const shop = "tampered-state.myshopify.com";
    const goodState = signState(stateSigningKey, tenantId);
    const tampered = goodState.slice(0, -2) + "AA";
    const query: Record<string, string> = {
      shop,
      code: "x",
      state: tampered,
      timestamp: "1700000003",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);
    const res = await fetch(cbUrl, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("GET /shopify/auth/callback returns 401 when the HMAC doesn't verify", async () => {
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    cbUrl.searchParams.set("shop", "acme.myshopify.com");
    cbUrl.searchParams.set("code", "x");
    cbUrl.searchParams.set("state", signState(stateSigningKey, tenantId));
    cbUrl.searchParams.set("hmac", "deadbeef".repeat(8));
    const res = await fetch(cbUrl, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
