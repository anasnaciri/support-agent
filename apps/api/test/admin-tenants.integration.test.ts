import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ShopifyAppProvisioningStore,
} from "@support-agent/services";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  connectorConnections,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — admin tenant list + detail (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const adminToken = "admin-tenants-token";
  const encryptionKey = randomBytes(32);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const shopA = "admin-list-a.myshopify.com";

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
    shopifyConnectRequiresProvisioning: true,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const authed = { authorization: `Bearer ${adminToken}` };

  const seed = () =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const prov = yield* ShopifyAppProvisioningStore;
          yield* prov.put({
            tenantId: TenantId(tenantA),
            clientId: "list-client-a",
            clientSecret: "list-secret-a",
          });
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId: TenantId(tenantA),
            provider: "shopify",
            shopDomain: shopA,
            accessToken: "shpoa_list_a",
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

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantA, name: "Tenant A", workosOrganizationId: "org_a" },
      { id: tenantB, name: "Tenant B" },
    ]);
    await seed();
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(connectorConnections)
      .where(sql`${connectorConnections.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
    await raw.close();
  });

  it("rejects an unauthenticated list request", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants`);
    expect(res.status).toBe(401);
  });

  it("lists tenants with provisioning status + connection counts", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants`, { headers: authed });
    expect(res.status).toBe(200);
    const body = await res.json();
    const a = body.tenants.find((t: { id: string }) => t.id === tenantA);
    const b = body.tenants.find((t: { id: string }) => t.id === tenantB);
    expect(a).toMatchObject({
      name: "Tenant A",
      workosOrganizationId: "org_a",
      shopifyApp: { provisioned: true, status: "ready" },
      connectionCount: 1,
    });
    expect(b).toMatchObject({
      name: "Tenant B",
      workosOrganizationId: null,
      shopifyApp: { provisioned: false, status: null },
      connectionCount: 0,
    });
  });

  it("returns tenant detail with shopify app (no secret) + connections", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants/${tenantA}`, {
      headers: authed,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("list-secret-a");
    const body = JSON.parse(text);
    expect(body.tenant.id).toBe(tenantA);
    expect(body.shopifyApp).toMatchObject({
      clientId: "list-client-a",
      status: "ready",
    });
    expect(body.shopifyApp.clientSecret).toBeUndefined();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      provider: "shopify",
      shopDomain: shopA,
    });
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await fetch(`${baseUrl}/admin/tenants/${randomUUID()}`, {
      headers: authed,
    });
    expect(res.status).toBe(404);
  });
});
