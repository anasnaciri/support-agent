import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  ConnectorCredentialStore,
  ShopifyAppProvisioningStore,
  computeHmac,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  connectorConnections,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { Layer } from "effect";
import { startServer, type ServerHandle } from "../server.js";
import {
  canonicalQueryForHmac,
  signState,
  verifyState,
} from "../features/shopify/install.js";
import {
  signInstallGrant,
  type InstallGrantProvider,
} from "../auth/install-grant.js";
import type { ApiConfig } from "../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — Shopify install + callback (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const encryptionKey = randomBytes(32);
  const encryptionKeyB64 = encryptionKey.toString("base64");
  const stateSigningKey = "test-state-key";

  // The dashboard-initiated install now carries a signed grant, not ?tenant=.
  const installGrant = (
    tid: string,
    provider: InstallGrantProvider = "shopify",
  ): string =>
    encodeURIComponent(
      signInstallGrant(
        stateSigningKey,
        { tenantId: tid, provider },
        Date.now() + 600_000,
      ),
    );
  const autoCreatedShopDomains = [
    "custom-dist-shop.myshopify.com",
    "signed-install-shop.myshopify.com",
  ] as const;
  const extraTenantIds: Array<string> = [];

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
    dashboardBaseUrl: null,
  };

  const acceptedSettings = {
    legalAcceptance: {
      dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
      dpaVersion: DPA_VERSION,
      acceptedAt: "2026-06-04T12:00:00.000Z",
      acceptedByUserId: "11111111-1111-1111-1111-111111111111",
    },
  } as const;

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    if (!raw) return;
    process.env["CREDENTIAL_ENCRYPTION_KEY"] = encryptionKeyB64;
    await raw.db
      .insert(tenants)
      .values({
        id: tenantId,
        name: "api-integ-test",
        settings: acceptedSettings,
      });
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
    for (const id of extraTenantIds) {
      await raw.db
        .delete(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
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

  const seedShopifyConnection = async (
    ownerTenantId: string,
    shop: string,
    status: "active" | "revoked" = "active",
  ): Promise<void> => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId: TenantId(ownerTenantId),
            provider: "shopify",
            shopDomain: shop,
            accessToken: `shpoa_seed_${status}`,
            scopes: ["read_orders"],
            apiVersion: "2025-01",
          });
          if (status === "revoked") {
            yield* store.revoke(TenantId(ownerTenantId), "shopify", shop);
          }
        }),
        ConnectorCredentialStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );
  };

  let webhookSequence = 0;
  const mockShopifyFetch = (token: {
    readonly access_token: string;
    readonly scope: string;
  }): void => {
    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        return new Response(JSON.stringify(token), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/graphql.json")) {
        const body = JSON.parse(String(init?.body)) as {
          variables?: {
            topic?: string;
            webhookSubscription?: {
              uri?: string;
            };
          };
        };
        return new Response(
          JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: {
                  id: `gid://shopify/WebhookSubscription/${++webhookSequence}`,
                  topic: body.variables?.topic,
                  uri: body.variables?.webhookSubscription?.uri,
                },
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;
  };

  it("GET /shopify/install redirects to Shopify's authorize URL", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com&grant=${installGrant(tenantId)}`,
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

  it("GET /shopify/install without a shop redirects to Shopify's store picker", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?grant=${installGrant(tenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toBe("https://admin.shopify.com/oauth/install?client_id=test-client-id");
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("support_agent_shopify_install=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
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

  it("GET /shopify/install rejects an invalid install grant", async () => {
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com&grant=not-a-real-grant`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_install_grant");
  });

  it("GET /shopify/install ignores a raw ?tenant= (cross-tenant injection blocked, 5th-audit #2)", async () => {
    // A raw tenant id is no longer trusted. With a shop but no signed grant
    // this falls through to the Shopify-initiated path, which requires a valid
    // HMAC — so it can't start an install for an arbitrary tenant.
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com&tenant=${tenantId}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("GET /shopify/install rejects a grant signed with the wrong key", async () => {
    const forged = encodeURIComponent(
      signInstallGrant(
        "attacker-key",
        { tenantId, provider: "shopify" },
        Date.now() + 600_000,
      ),
    );
    const res = await fetch(
      `${baseUrl}/shopify/install?shop=acme.myshopify.com&grant=${forged}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(401);
  });

  it("GET /shopify/install rejects a tenant without legal acceptance", async () => {
    const noLegalTenantId = randomUUID();
    extraTenantIds.push(noLegalTenantId);
    await raw!.db
      .insert(tenants)
      .values({ id: noLegalTenantId, name: "no-legal-shopify" });

    const res = await fetch(
      `${baseUrl}/shopify/install?shop=no-legal.myshopify.com&grant=${installGrant(noLegalTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
  });

  it("GET /shopify/install blocks a dashboard tenant from connecting another tenant's active shop", async () => {
    const shop = "owned-active-shop.myshopify.com";
    const ownerTenantId = randomUUID();
    extraTenantIds.push(ownerTenantId);
    await raw!.db
      .insert(tenants)
      .values({ id: ownerTenantId, name: shop, shopifyDomain: shop });
    await seedShopifyConnection(ownerTenantId, shop);

    const res = await fetch(
      `${baseUrl}/shopify/install?shop=${shop}&grant=${installGrant(tenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "shop_already_connected",
      shop,
    });
  });

  it("GET /shopify/install accepts a signed request for a preprovisioned accepted shop", async () => {
    const shop = "signed-install-shop.myshopify.com";
    const signedTenantId = randomUUID();
    extraTenantIds.push(signedTenantId);
    await raw!.db.insert(tenants).values({
      id: signedTenantId,
      name: shop,
      shopifyDomain: shop,
      settings: acceptedSettings,
    });
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
    expect(decoded!.tenantId).toBe(signedTenantId);

    const tenantRows = await raw!.db
      .select()
      .from(tenants)
      .where(sql`${tenants.shopifyDomain} = ${shop}`);
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]!.id).toBe(decoded!.tenantId);
  });

  it("GET /shopify/install uses the pending dashboard tenant after Shopify store selection", async () => {
    const shop = "signed-cookie-shop.myshopify.com";
    const query: Record<string, string> = {
      shop,
      host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvc2lnbmVkLWNvb2tpZQ",
      timestamp: "1700000005",
    };
    const canonical = canonicalQueryForHmac(query);
    const hmac = computeHmac(cfg.shopify.clientSecret, canonical);
    const pendingState = signState(stateSigningKey, tenantId);

    const url = new URL(`${baseUrl}/shopify/install`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("hmac", hmac);

    const res = await fetch(url, {
      redirect: "manual",
      headers: {
        Cookie: `support_agent_shopify_install=${encodeURIComponent(pendingState)}`,
      },
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location");
    expect(loc).toBeTruthy();
    const redirect = new URL(loc!);
    expect(redirect.host).toBe(shop);

    const state = redirect.searchParams.get("state");
    expect(state).toBeTruthy();
    const decoded = verifyState(stateSigningKey, state!);
    expect(decoded?.tenantId).toBe(tenantId);

    const tenantRows = await raw!.db
      .select()
      .from(tenants)
      .where(sql`${tenants.shopifyDomain} = ${shop}`);
    expect(tenantRows).toHaveLength(0);
  });

  it("GET /shopify/auth/callback verifies HMAC, exchanges code, and persists the token", async () => {
    mockShopifyFetch({
      access_token: "shpoa_test_token",
      scope: "read_orders,read_customers",
    });

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
    expect(body.appUninstalledWebhook).toEqual({
      id: expect.stringMatching(/^gid:\/\/shopify\/WebhookSubscription\//),
      topic: "APP_UNINSTALLED",
      uri: "http://localhost/webhooks/shopify/app/uninstalled",
      status: "created",
    });

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
    expect(fetched.metadata).toMatchObject({
      shopifyWebhooks: {
        appUninstalled: {
          uri: "http://localhost/webhooks/shopify/app/uninstalled",
          status: "created",
        },
      },
    });
  });

  it("GET /shopify/auth/callback for a pilot tenant verifies with the tenant's app secret and marks the provisioning row connected", async () => {
    mockShopifyFetch({ access_token: "shpoa_pilot_token", scope: "read_orders" });

    const pilotTenantId = randomUUID();
    extraTenantIds.push(pilotTenantId);
    const shop = "pilot-callback.myshopify.com";
    const pilotSecret = "pilot-callback-secret";

    await raw!.db
      .insert(tenants)
      .values({ id: pilotTenantId, name: "pilot-callback", settings: acceptedSettings });
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const provisioning = yield* ShopifyAppProvisioningStore;
          yield* provisioning.put({
            tenantId: TenantId(pilotTenantId),
            clientId: "pilot-callback-client",
            clientSecret: pilotSecret,
          });
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

    const state = signState(stateSigningKey, pilotTenantId);
    const query: Record<string, string> = {
      shop,
      code: "the-code",
      state,
      timestamp: "1700000001",
    };
    // Signed with the TENANT's app secret — the global secret must NOT verify.
    const hmac = computeHmac(pilotSecret, canonicalQueryForHmac(query));

    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    const res = await fetch(cbUrl, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // markConnected stamped shop_domain + status onto the provisioning row.
    const prov = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const provisioning = yield* ShopifyAppProvisioningStore;
          return yield* provisioning.get(TenantId(pilotTenantId));
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );
    expect(prov?.shopDomain).toBe(shop);
    expect(prov?.status).toBe("connected");
  });

  it("GET /shopify/auth/callback rejects a shop that doesn't match the provisioned shop (5th-audit #5)", async () => {
    mockShopifyFetch({ access_token: "shpoa_x", scope: "read_orders" });

    const t = randomUUID();
    extraTenantIds.push(t);
    const provisionedShop = "provisioned-shop.myshopify.com";
    const otherShop = "other-shop.myshopify.com";
    const secret = "mismatch-secret";

    await raw!.db
      .insert(tenants)
      .values({ id: t, name: "mismatch", settings: acceptedSettings });
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const provisioning = yield* ShopifyAppProvisioningStore;
          // Operator recorded `provisionedShop` at provisioning (A4).
          yield* provisioning.put({
            tenantId: TenantId(t),
            clientId: "mismatch-client",
            clientSecret: secret,
            shopDomain: provisionedShop,
          });
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

    // Validly-signed callback (tenant's own secret) but for a DIFFERENT shop.
    const state = signState(stateSigningKey, t);
    const query: Record<string, string> = {
      shop: otherShop,
      code: "the-code",
      state,
      timestamp: "1700000002",
    };
    const hmac = computeHmac(secret, canonicalQueryForHmac(query));
    const cbUrl = new URL(`${baseUrl}/shopify/auth/callback`);
    for (const [k, v] of Object.entries(query)) cbUrl.searchParams.set(k, v);
    cbUrl.searchParams.set("hmac", hmac);

    const res = await fetch(cbUrl, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("shop_mismatch");
    expect(body.expected).toBe(provisionedShop);
  });

  it("GET /shopify/auth/callback without state uses a preprovisioned accepted tenant for the shop", async () => {
    mockShopifyFetch({
      access_token: "shpoa_custom_dist",
      scope: "read_orders,read_customers",
    });

    const shop = "custom-dist-shop.myshopify.com";
    const customDistTenantId = randomUUID();
    extraTenantIds.push(customDistTenantId);
    await raw!.db.insert(tenants).values({
      id: customDistTenantId,
      name: shop,
      shopifyDomain: shop,
      settings: acceptedSettings,
    });
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
    expect(body.tenantId).toBe(customDistTenantId);

    // The preprovisioned tenants row stayed linked to the shop domain.
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

  it("GET /shopify/auth/callback rejects a preprovisioned shop without legal acceptance before token exchange", async () => {
    let tokenExchangeCalled = false;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/admin/oauth/access_token")) {
        tokenExchangeCalled = true;
      }
      return originalFetch(url as never, init);
    }) as unknown as typeof fetch;

    const shop = "callback-no-legal.myshopify.com";
    const noLegalTenantId = randomUUID();
    extraTenantIds.push(noLegalTenantId);
    await raw!.db.insert(tenants).values({
      id: noLegalTenantId,
      name: shop,
      shopifyDomain: shop,
    });
    const query: Record<string, string> = {
      shop,
      code: "the-code-no-legal",
      timestamp: "1700000099",
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
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "legal_acceptance_required" });
    expect(tokenExchangeCalled).toBe(false);
  });

  it("a second install for the same shop reuses the same tenant (idempotent resolve)", async () => {
    mockShopifyFetch({
      access_token: "shpoa_reinstall",
      scope: "read_orders,read_customers",
    });

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

  it("GET /shopify/auth/callback transfers a revoked shop to the signed tenant after OAuth succeeds", async () => {
    mockShopifyFetch({
      access_token: "shpoa_transferred",
      scope: "read_orders,read_customers",
    });

    const shop = "revoked-transfer-shop.myshopify.com";
    const oldTenantId = randomUUID();
    const newTenantId = randomUUID();
    extraTenantIds.push(oldTenantId, newTenantId);
    await raw!.db
      .insert(tenants)
      .values([
        { id: oldTenantId, name: "old-transfer-owner", shopifyDomain: shop },
        {
          id: newTenantId,
          name: "new-transfer-owner",
          settings: acceptedSettings,
        },
      ]);
    await seedShopifyConnection(oldTenantId, shop, "revoked");

    const query: Record<string, string> = {
      shop,
      code: "the-code-transfer",
      state: signState(stateSigningKey, newTenantId),
      timestamp: "1700000005",
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
    expect(body.tenantId).toBe(newTenantId);
    expect(body.ownershipTransferred).toBe(true);

    const tenantRows = await raw!.db
      .select({
        id: tenants.id,
        shopifyDomain: tenants.shopifyDomain,
      })
      .from(tenants)
      .where(sql`${tenants.id} IN (${oldTenantId}, ${newTenantId})`);
    expect(
      tenantRows.find((row) => row.id === oldTenantId)!.shopifyDomain,
    ).toBeNull();
    expect(
      tenantRows.find((row) => row.id === newTenantId)!.shopifyDomain,
    ).toBe(shop);

    const ccRows = await raw!.db
      .select({
        tenantId: connectorConnections.tenantId,
        status: connectorConnections.status,
      })
      .from(connectorConnections)
      .where(sql`${connectorConnections.shopDomain} = ${shop}`);
    expect(ccRows).toEqual(
      expect.arrayContaining([
        { tenantId: oldTenantId, status: "revoked" },
        { tenantId: newTenantId, status: "active" },
      ]),
    );
  });

  it("GET /shopify/auth/callback without Accept: application/json redirects browsers to the merchant admin", async () => {
    mockShopifyFetch({
      access_token: "shpoa_browser",
      scope: "read_orders",
    });

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
    mockShopifyFetch({
      access_token: "shpoa_host",
      scope: "read_orders",
    });

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
    const [encodedPayload, encodedSig] = goodState.split(".");
    expect(encodedPayload).toBeDefined();
    expect(encodedSig).toBeDefined();
    const payload = Buffer.from(encodedPayload!, "base64url").toString("utf8");
    const tamperedPayload = Buffer.from(
      payload.replace(tenantId, randomUUID()),
      "utf8",
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${encodedSig}`;
    expect(verifyState(stateSigningKey, tampered)).toBeNull();
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

  describe("POST /webhooks/shopify/app/uninstalled", () => {
    // Each test seeds its own shop + tenant + active connector so the test
    // assertions are self-contained and order-independent.
    const seedShop = async (
      shop: string,
    ): Promise<{ tenantId: string }> => {
      const newTenantId = randomUUID();
      await raw!.db
        .insert(tenants)
        .values({ id: newTenantId, name: shop, shopifyDomain: shop });
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ConnectorCredentialStore;
            yield* store.put({
              tenantId: TenantId(newTenantId),
              provider: "shopify",
              shopDomain: shop,
              accessToken: "shpoa_seed_for_uninstall_test",
              scopes: ["read_orders"],
              apiVersion: "2025-01",
            });
          }),
          ConnectorCredentialStoreLive(encryptionKey).pipe(
            Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
          ),
        ).pipe(Effect.scoped),
      );
      return { tenantId: newTenantId };
    };

    const post = async (
      headers: Record<string, string>,
      body: string,
    ): Promise<Response> =>
      fetch(`${baseUrl}/webhooks/shopify/app/uninstalled`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    const signBody = (body: string): string =>
      Buffer.from(
        computeHmac(cfg.shopify.clientSecret, body),
        "hex",
      ).toString("base64");

    it("flips the matching connector row to revoked on a valid signature", async () => {
      const shop = "uninstall-happy.myshopify.com";
      const { tenantId: t } = await seedShop(shop);
      const body = JSON.stringify({
        id: 1,
        name: shop,
        domain: shop.replace(".myshopify.com", ".com"),
      });
      const res = await post(
        {
          "X-Shopify-Hmac-Sha256": signBody(body),
          "X-Shopify-Shop-Domain": shop,
        },
        body,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).action).toBe("revoked");

      const rows = await raw!.db
        .select()
        .from(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${t}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("revoked");
      expect(rows[0]!.revokedAt).not.toBeNull();
    });

    it("returns 401 on a bad signature and does NOT mutate the row", async () => {
      const shop = "uninstall-badsig.myshopify.com";
      const { tenantId: t } = await seedShop(shop);
      const body = JSON.stringify({ id: 2, name: shop });
      const res = await post(
        {
          "X-Shopify-Hmac-Sha256": Buffer.from("not-the-right-sig").toString(
            "base64",
          ),
          "X-Shopify-Shop-Domain": shop,
        },
        body,
      );
      expect(res.status).toBe(401);

      const rows = await raw!.db
        .select()
        .from(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${t}`);
      expect(rows[0]!.status).toBe("active");
    });

    it("returns 200 with noop_unknown_shop when no tenant is linked to the shop", async () => {
      const shop = "no-tenant-here.myshopify.com";
      const body = JSON.stringify({ id: 3, name: shop });
      const res = await post(
        {
          "X-Shopify-Hmac-Sha256": signBody(body),
          "X-Shopify-Shop-Domain": shop,
        },
        body,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).action).toBe("noop_unknown_shop");
    });

    it("is idempotent: a second uninstall for an already-revoked row still returns 200", async () => {
      const shop = "uninstall-idempotent.myshopify.com";
      const { tenantId: t } = await seedShop(shop);
      const body = JSON.stringify({ id: 4, name: shop });
      const headers = {
        "X-Shopify-Hmac-Sha256": signBody(body),
        "X-Shopify-Shop-Domain": shop,
      };
      const first = await post(headers, body);
      expect(first.status).toBe(200);
      expect((await first.json()).action).toBe("revoked");

      const second = await post(headers, body);
      // The row already exists (revoked) — revoke() finds it and re-sets
      // revokedAt/updatedAt. Action stays "revoked"; row stays revoked.
      expect(second.status).toBe(200);
      expect((await second.json()).action).toBe("revoked");

      const rows = await raw!.db
        .select()
        .from(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${t}`);
      expect(rows[0]!.status).toBe("revoked");
    });

    it("returns 400 when required headers are missing", async () => {
      const res = await post({}, "{}");
      expect(res.status).toBe(400);
    });

    // Sweep the seeded tenants + their cascaded connector rows so this
    // describe block doesn't leak fixtures into the outer afterAll.
    afterAll(async () => {
      if (!raw) return;
      for (const shop of [
        "uninstall-happy.myshopify.com",
        "uninstall-badsig.myshopify.com",
        "uninstall-idempotent.myshopify.com",
      ]) {
        await raw.db
          .delete(tenants)
          .where(sql`${tenants.shopifyDomain} = ${shop}`);
      }
    });
  });

  describe("POST /webhooks/shopify/app/uninstalled — pilot per-tenant app", () => {
    const goodShop = "pilot-uninstall-good.myshopify.com";
    const badShop = "pilot-uninstall-bad.myshopify.com";
    const tenantSecret = "pilot-app-secret-xyz";

    // Operator-provisioned pilot app (its own secret) + a connected shop +
    // an active connector row for the webhook to revoke.
    const seedPilot = async (shop: string): Promise<{ tenantId: string }> => {
      const newTenantId = randomUUID();
      await raw!.db
        .insert(tenants)
        .values({ id: newTenantId, name: shop, shopifyDomain: shop });
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const provisioning = yield* ShopifyAppProvisioningStore;
            yield* provisioning.put({
              tenantId: TenantId(newTenantId),
              clientId: "pilot-client-id",
              clientSecret: tenantSecret,
            });
            yield* provisioning.markConnected(TenantId(newTenantId), shop);
            const store = yield* ConnectorCredentialStore;
            yield* store.put({
              tenantId: TenantId(newTenantId),
              provider: "shopify",
              shopDomain: shop,
              accessToken: "shpoa_pilot_seed",
              scopes: ["read_orders"],
              apiVersion: "2025-01",
            });
          }),
          Layer.mergeAll(
            ShopifyAppProvisioningStoreLive(encryptionKey),
            ConnectorCredentialStoreLive(encryptionKey),
          ).pipe(Layer.provide(DbClientLive({ databaseUrl: databaseUrl! }))),
        ).pipe(Effect.scoped),
      );
      return { tenantId: newTenantId };
    };

    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${baseUrl}/webhooks/shopify/app/uninstalled`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    const signBodyWith = (secret: string, body: string): string =>
      Buffer.from(computeHmac(secret, body), "hex").toString("base64");

    it("verifies a webhook signed with the tenant's own app secret", async () => {
      const { tenantId: t } = await seedPilot(goodShop);
      const body = JSON.stringify({ id: 9, name: goodShop });
      const res = await post(
        {
          "X-Shopify-Hmac-Sha256": signBodyWith(tenantSecret, body),
          "X-Shopify-Shop-Domain": goodShop,
        },
        body,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).action).toBe("revoked");

      const rows = await raw!.db
        .select()
        .from(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${t}`);
      expect(rows[0]!.status).toBe("revoked");
    });

    it("rejects the same webhook signed with the GLOBAL app secret", async () => {
      const { tenantId: t } = await seedPilot(badShop);
      const body = JSON.stringify({ id: 10, name: badShop });
      const res = await post(
        {
          "X-Shopify-Hmac-Sha256": signBodyWith(cfg.shopify.clientSecret, body),
          "X-Shopify-Shop-Domain": badShop,
        },
        body,
      );
      expect(res.status).toBe(401);

      const rows = await raw!.db
        .select()
        .from(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${t}`);
      expect(rows[0]!.status).toBe("active");
    });

    afterAll(async () => {
      if (!raw) return;
      for (const shop of [goodShop, badShop]) {
        await raw.db
          .delete(tenants)
          .where(sql`${tenants.shopifyDomain} = ${shop}`);
      }
    });
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
