import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import {
  ShopifyAppProvisioningStore,
  ShopifyService,
  ShopifyServiceTest,
  type OrderPiiPresence,
} from "@support-agent/services";
import {
  auditLog,
  connectorConnections,
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  makeDbClient,
  shopifyAppProvisioning,
  tenants,
} from "@support-agent/db";
import { eq } from "drizzle-orm";
import { startServer, type ServerHandle } from "../src/server.js";
import { checkAdminShopifyAppPcd } from "../src/admin-shopify-app.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — admin Shopify app provisioning (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const adminToken = "admin-shopify-token";
  const encryptionKey = randomBytes(32);
  const tenantId = randomUUID();
  const SECRET = "shpss_admin_entered_secret";

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey,
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
    dashboardApiToken: "dash",
    adminApiToken: adminToken,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const url = (id: string) => `${baseUrl}/admin/tenants/${id}/shopify-app`;
  const authed = { authorization: `Bearer ${adminToken}` };

  const readStored = (id: string) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          return yield* store.get(TenantId(id));
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "admin-prov" });
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(url(tenantId));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(url(tenantId), {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("GET reports not-provisioned before any PUT", async () => {
    const res = await fetch(url(tenantId), { headers: authed });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provisioned).toBe(false);
    expect(body.provisioning).toBeNull();
  });

  it("PUT rejects a body missing the client credentials", async () => {
    const res = await fetch(url(tenantId), {
      method: "PUT",
      headers: { ...authed, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "only-id" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT provisions the app, stores the secret encrypted, and never returns it", async () => {
    const res = await fetch(url(tenantId), {
      method: "PUT",
      headers: { ...authed, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "shopify_client_admin", clientSecret: SECRET }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The response must never echo the secret.
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.provisioning.clientId).toBe("shopify_client_admin");
    expect(body.provisioning.status).toBe("ready");
    expect(body.provisioning.shopDomain).toBeNull();
    expect(body.provisioning.clientSecret).toBeUndefined();

    // Secret is retrievable (decrypted) through the store...
    const stored = await readStored(tenantId);
    expect(stored?.clientSecret).toBe(SECRET);
    // ...but stored encrypted at rest.
    const rows = await raw!.db
      .select()
      .from(shopifyAppProvisioning)
      .where(sql`${shopifyAppProvisioning.tenantId} = ${tenantId}`);
    expect(rows[0]!.clientSecretEncrypted.toString("utf8")).not.toContain(SECRET);

    // An audit row records the provisioning.
    const audits = await raw!.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantId}`);
    expect(audits.some((a) => a.action === "shopify_app.provisioned")).toBe(true);
  });

  it("GET reports provisioned without leaking the secret", async () => {
    const res = await fetch(url(tenantId), { headers: authed });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.provisioned).toBe(true);
    expect(body.provisioning.status).toBe("ready");
    expect(body.provisioning.clientSecret).toBeUndefined();
  });

  it("PUT for an unknown tenant returns 404", async () => {
    const res = await fetch(url(randomUUID()), {
      method: "PUT",
      headers: { ...authed, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "x", clientSecret: "y" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE revokes the provisioning", async () => {
    const res = await fetch(url(tenantId), { method: "DELETE", headers: authed });
    expect(res.status).toBe(200);
    expect((await res.json()).provisioning.status).toBe("revoked");
    const stored = await readStored(tenantId);
    expect(stored?.status).toBe("revoked");
  });

  it("DELETE on an un-provisioned tenant returns 404", async () => {
    const fresh = randomUUID();
    await raw!.db.insert(tenants).values({ id: fresh, name: "fresh" });
    const res = await fetch(url(fresh), { method: "DELETE", headers: authed });
    expect(res.status).toBe(404);
    await raw!.db.delete(tenants).where(sql`${tenants.id} = ${fresh}`);
  });

  // ---- PCD live check ----

  const pcdUrl = (id: string) => `${url(id)}/pcd-check`;

  const runPcd = (id: string, samples: ReadonlyArray<OrderPiiPresence>) =>
    Effect.runPromise(
      Effect.provide(
        checkAdminShopifyAppPcd(id),
        Layer.merge(
          DbClientLive({ databaseUrl: databaseUrl! }),
          ShopifyServiceTest({ recentOrderPiiPresence: samples }),
        ),
      ).pipe(Effect.scoped),
    );

  it("PCD check reports tenant_not_found for an unknown tenant", async () => {
    const out = await runPcd(randomUUID(), []);
    expect(out.kind).toBe("tenant_not_found");
  });

  it("PCD check verdict is 'present' when orders return customer PII", async () => {
    const out = await runPcd(tenantId, [
      {
        orderName: "#2001",
        hasEmail: true,
        hasCustomerName: true,
        hasShippingAddress: true,
      },
    ]);
    expect(out.kind).toBe("summary");
    if (out.kind === "summary") {
      expect(out.verdict).toBe("present");
      expect(out.sawEmail).toBe(true);
      expect(out.ordersChecked).toBe(1);
    }
  });

  it("PCD check verdict is 'redacted' when no order returns email", async () => {
    const out = await runPcd(tenantId, [
      {
        orderName: "#2002",
        hasEmail: false,
        hasCustomerName: false,
        hasShippingAddress: false,
      },
    ]);
    expect(out.kind).toBe("summary");
    if (out.kind === "summary") expect(out.verdict).toBe("redacted");
  });

  it("PCD check verdict is 'no_orders' when the store has none", async () => {
    const out = await runPcd(tenantId, []);
    expect(out.kind).toBe("summary");
    if (out.kind === "summary") expect(out.verdict).toBe("no_orders");
  });

  it("HTTP pcd-check returns not_connected when the store isn't connected", async () => {
    // The real server uses the Live ShopifyService; with no shopify
    // connector_connection row, credentials resolve to ShopifyAuthMissing,
    // which the endpoint maps to not_connected (an expected operator state).
    const res = await fetch(pcdUrl(tenantId), {
      method: "POST",
      headers: authed,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.kind).toBe("not_connected");
  });

  it("HTTP pcd-check rejects an unauthenticated request", async () => {
    const res = await fetch(pcdUrl(tenantId), { method: "POST" });
    expect(res.status).toBe(401);
  });
});

// A4 — operator records the store domain at provisioning.
describeIfDb("apps/api — admin provisioning shop_domain capture (A4)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const adminToken = "admin-a4-token";
  const encryptionKey = randomBytes(32);
  const t1 = randomUUID();
  const t2 = randomUUID();
  const ownerTenant = randomUUID();
  const shop = "a4-pilot.myshopify.com";
  const ownedShop = "a4-owned.myshopify.com";

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey,
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
    dashboardApiToken: "dash",
    adminApiToken: adminToken,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const url = (id: string) => `${baseUrl}/admin/tenants/${id}/shopify-app`;
  const authed = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

  beforeAll(async () => {
    if (!raw) return;
    for (const id of [t1, t2, ownerTenant]) {
      await raw.db.insert(tenants).values({ id, name: `a4-${id.slice(0, 6)}` });
    }
    // ownerTenant actively connects ownedShop via a connector row, so a later
    // attempt to provision ownedShop for another tenant must 409.
    await raw.db.insert(connectorConnections).values({
      id: randomUUID(),
      tenantId: ownerTenant,
      provider: "shopify",
      shopDomain: ownedShop,
      accessTokenEncrypted: Buffer.from("x"),
      status: "active",
    });
    await raw.db
      .update(tenants)
      .set({ shopifyDomain: ownedShop })
      .where(eq(tenants.id, ownerTenant));
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [t1, t2, ownerTenant]) {
      await raw.db
        .delete(connectorConnections)
        .where(eq(connectorConnections.tenantId, id));
      await raw.db
        .delete(shopifyAppProvisioning)
        .where(eq(shopifyAppProvisioning.tenantId, id));
      await raw.db.delete(auditLog).where(eq(auditLog.tenantId, id));
      await raw.db.delete(tenants).where(eq(tenants.id, id));
    }
    await raw.close();
  });

  it("PUT with a shopDomain records it on the row AND stamps tenants.shopify_domain", async () => {
    const res = await fetch(url(t1), {
      method: "PUT",
      headers: authed,
      body: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        shopDomain: "https://A4-Pilot.myshopify.com/admin", // normalized server-side
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provisioning.shopDomain).toBe(shop);

    const rows = await raw!.db
      .select({ shopifyDomain: tenants.shopifyDomain })
      .from(tenants)
      .where(eq(tenants.id, t1));
    expect(rows[0]!.shopifyDomain).toBe(shop);
  });

  it("PUT with an invalid shopDomain returns 400", async () => {
    const res = await fetch(url(t2), {
      method: "PUT",
      headers: authed,
      body: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        shopDomain: "not-a-shop",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_shop");
  });

  it("PUT with a shop already actively connected to another tenant returns 409", async () => {
    const res = await fetch(url(t2), {
      method: "PUT",
      headers: authed,
      body: JSON.stringify({
        clientId: "cid",
        clientSecret: "csecret",
        shopDomain: ownedShop,
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("shop_already_connected");
    // t2 must NOT have been provisioned (claim-first aborts before the write).
    const prov = await raw!.db
      .select()
      .from(shopifyAppProvisioning)
      .where(eq(shopifyAppProvisioning.tenantId, t2));
    expect(prov).toHaveLength(0);
  });
});
