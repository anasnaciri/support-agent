import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import { ShopifyAppProvisioningStore } from "@support-agent/services";
import {
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — GET /dashboard/shopify-app (gate)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const token = "gate-dash-token";
  const encryptionKey = randomBytes(32);
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const saasOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const saasTenantId = randomUUID();

  const baseCfg = (requiresProvisioning: boolean): ApiConfig =>
    ({
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
      dashboardApiToken: token,
      adminApiToken: null,
      shopifyConnectRequiresProvisioning: requiresProvisioning,
    }) as ApiConfig;

  let pilot: ServerHandle | null = null;
  let saas: ServerHandle | null = null;
  let pilotUrl = "";
  let saasUrl = "";

  const provision = (tenant: string) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          yield* store.put({
            tenantId: TenantId(tenant),
            clientId: "pilot-client",
            clientSecret: "pilot-secret",
          });
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

  const revoke = (tenant: string) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          yield* store.revoke(TenantId(tenant));
        }),
        ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
          Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
        ),
      ).pipe(Effect.scoped),
    );

  const get = (url: string, org: string) =>
    fetch(`${url}/dashboard/shopify-app`, {
      headers: { authorization: `Bearer ${token}`, "x-org-id": org },
    });

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "pilot-gate", workosOrganizationId: orgId });
    await raw.db.insert(tenants).values({
      id: saasTenantId,
      name: "saas-gate",
      workosOrganizationId: saasOrgId,
    });
    pilot = await startServer(baseCfg(true));
    saas = await startServer(baseCfg(false));
    pilotUrl = `http://localhost:${pilot.port}`;
    saasUrl = `http://localhost:${saas.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (pilot) await pilot.close();
    if (saas) await saas.close();
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantId}, ${saasTenantId})`);
    await raw.close();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${pilotUrl}/dashboard/shopify-app`);
    expect(res.status).toBe(401);
  });

  it("pilot mode: not provisioned → requiresProvisioning true, provisioned false", async () => {
    const res = await get(pilotUrl, orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: false,
      status: null,
    });
  });

  it("pilot mode: after provisioning → provisioned true, status ready", async () => {
    await provision(tenantId);
    const res = await get(pilotUrl, orgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: true,
      status: "ready",
    });
  });

  it("pilot mode: after revoke → provisioned false, status revoked", async () => {
    await revoke(tenantId);
    const res = await get(pilotUrl, orgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: false,
      status: "revoked",
    });
  });

  it("saas mode: requiresProvisioning false even with no row", async () => {
    const res = await get(saasUrl, saasOrgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: false,
      provisioned: false,
      status: null,
    });
  });
});
