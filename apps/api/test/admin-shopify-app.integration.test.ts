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
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  makeDbClient,
  shopifyAppProvisioning,
  tenants,
} from "@support-agent/db";
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
