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
  const mintOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const saasTenantId = randomUUID();
  const mintTenantId = randomUUID();

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

  // SaaS deployment that ships no Shopify app at all (e.g. email-only) — no
  // workspace can start a Shopify connect, and the gate must say so.
  const noAppCfg = (): ApiConfig => {
    const cfg = baseCfg(false);
    return {
      ...cfg,
      shopify: { ...cfg.shopify, clientId: null, clientSecret: null },
    } as ApiConfig;
  };

  let pilot: ServerHandle | null = null;
  let saas: ServerHandle | null = null;
  let noApp: ServerHandle | null = null;
  let pilotUrl = "";
  let saasUrl = "";
  let noAppUrl = "";

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

  const mint = (url: string, org: string, provider = "shopify") =>
    fetch(`${url}/dashboard/connect/${provider}`, {
      method: "POST",
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
    await raw.db.insert(tenants).values({
      id: mintTenantId,
      name: "pilot-mint",
      workosOrganizationId: mintOrgId,
    });
    pilot = await startServer(baseCfg(true));
    saas = await startServer(baseCfg(false));
    noApp = await startServer(noAppCfg());
    pilotUrl = `http://localhost:${pilot.port}`;
    saasUrl = `http://localhost:${saas.port}`;
    noAppUrl = `http://localhost:${noApp.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (pilot) await pilot.close();
    if (saas) await saas.close();
    if (noApp) await noApp.close();
    await raw.db
      .delete(tenants)
      .where(
        sql`${tenants.id} IN (${tenantId}, ${saasTenantId}, ${mintTenantId})`,
      );
    await raw.close();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${pilotUrl}/dashboard/shopify-app`);
    expect(res.status).toBe(401);
  });

  it("pilot mode: not provisioned → requiresProvisioning true, provisioned false, unavailable", async () => {
    const res = await get(pilotUrl, orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: false,
      status: null,
      available: false,
    });
  });

  it("pilot mode: after provisioning → provisioned true, status ready, available", async () => {
    await provision(tenantId);
    const res = await get(pilotUrl, orgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: true,
      status: "ready",
      available: true,
    });
  });

  it("pilot mode: after revoke → provisioned false, status revoked, unavailable", async () => {
    await revoke(tenantId);
    const res = await get(pilotUrl, orgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: true,
      provisioned: false,
      status: "revoked",
      available: false,
    });
  });

  it("saas mode: requiresProvisioning false even with no row — global app available", async () => {
    const res = await get(saasUrl, saasOrgId);
    expect(await res.json()).toEqual({
      requiresProvisioning: false,
      provisioned: false,
      status: null,
      available: true,
    });
  });

  it("saas mode with no global app: unavailable", async () => {
    const res = await get(noAppUrl, saasOrgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requiresProvisioning: false,
      provisioned: false,
      status: null,
      available: false,
    });
  });

  // The grant mint is the server-side gate behind the button (the button
  // state is only a UX hint): a workspace with no resolvable app must never
  // be handed an install URL — that is exactly how an unprovisioned
  // workspace ended up running OAuth on the deployment-wide credentials.
  it("mint: pilot + unprovisioned workspace → 403, no grant", async () => {
    const res = await mint(pilotUrl, mintOrgId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "shopify_provisioning_required",
      reason: "not_provisioned",
    });
  });

  it("mint: pilot + provisioned workspace → grant minted", async () => {
    await provision(mintTenantId);
    const res = await mint(pilotUrl, mintOrgId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("/shopify/install?grant=");
  });

  it("mint: pilot + revoked provisioning → 403, no grant", async () => {
    await revoke(mintTenantId);
    const res = await mint(pilotUrl, mintOrgId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "shopify_provisioning_required",
      reason: "revoked",
    });
  });

  it("mint: pilot gate does not block other providers", async () => {
    const res = await mint(pilotUrl, mintOrgId, "gmail");
    expect(res.status).toBe(200);
  });

  it("mint: saas + global app → grant minted", async () => {
    const res = await mint(saasUrl, saasOrgId);
    expect(res.status).toBe(200);
  });

  it("mint: saas with no global app → refused", async () => {
    const res = await mint(noAppUrl, saasOrgId);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "shopify_app_not_configured" });
  });
});
