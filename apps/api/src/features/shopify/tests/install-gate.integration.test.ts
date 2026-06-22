import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { TenantId } from "@support-agent/agent-core";
import {
  ShopifyAppProvisioningStore,
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
} from "@support-agent/services";
import {
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import { signInstallGrant } from "../../../auth/install-grant.js";
import type { ApiConfig } from "../../../bootstrap.js";

// Dashboard-initiated installs carry a signed grant (key "k" matches pilotCfg).
const grant = (tid: string): string =>
  encodeURIComponent(
    signInstallGrant("k", { tenantId: tid, provider: "shopify" }, Date.now() + 600_000),
  );

// A1 — the pilot provisioning gate must be enforced at the INSTALL endpoint,
// not just the dashboard overview. In pilot mode an unprovisioned (or revoked)
// tenant must be refused, NOT silently resolved to the global Shopify app.

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — GET /shopify/install (pilot provisioning gate)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const encryptionKey = randomBytes(32);
  const unprovisionedTenantId = randomUUID();
  const revokedTenantId = randomUUID();
  const readyTenantId = randomUUID();
  const shopBoundTenantId = randomUUID();
  const installLinkTenantId = randomUUID();
  const boundShop = "bound-store.myshopify.com";
  const installLinkShop = "install-link-store.myshopify.com";
  const storeInstallLink =
    "https://admin.shopify.com/store/install-link-store/oauth/install_custom_app?client_id=pilot-client";
  const blockedShop = `install-gate-blocked-${randomUUID()}.myshopify.com`;

  const acceptedSettings = {
    legalAcceptance: {
      dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
      dpaVersion: DPA_VERSION,
      acceptedAt: "2026-06-04T12:00:00.000Z",
      acceptedByUserId: "11111111-1111-1111-1111-111111111111",
    },
  } as const;

  // Pilot deployment: SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true, with a
  // global app still configured (the gate must override the fallback).
  const pilotCfg: ApiConfig = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey,
    stateSigningKey: "k",
    shopify: {
      clientId: "global-client",
      clientSecret: "global-secret",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: null,
    adminApiToken: null,
    shopifyConnectRequiresProvisioning: true,
  } as ApiConfig;

  let pilot: ServerHandle | null = null;
  let pilotUrl = "";

  const provisioningLayer = ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const provision = (
    tenant: string,
    shopDomain?: string,
    installLink?: string,
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          yield* store.put({
            tenantId: TenantId(tenant),
            clientId: "pilot-client",
            clientSecret: "pilot-secret",
            ...(shopDomain ? { shopDomain } : {}),
            ...(installLink ? { installLink } : {}),
          });
        }),
        provisioningLayer,
      ).pipe(Effect.scoped),
    );

  const revoke = (tenant: string) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          yield* store.revoke(TenantId(tenant));
        }),
        provisioningLayer,
      ).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    for (const id of [
      unprovisionedTenantId,
      revokedTenantId,
      readyTenantId,
      shopBoundTenantId,
      installLinkTenantId,
    ]) {
      await raw.db
        .insert(tenants)
        .values({ id, name: `install-gate-${id.slice(0, 6)}`, settings: acceptedSettings });
    }
    await provision(revokedTenantId);
    await revoke(revokedTenantId);
    await provision(readyTenantId);
    await provision(shopBoundTenantId, boundShop);
    await provision(installLinkTenantId, installLinkShop, storeInstallLink);

    pilot = await startServer(pilotCfg);
    pilotUrl = `http://localhost:${pilot.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (pilot) await pilot.close();
    await raw.db
      .delete(tenants)
      .where(
        sql`${tenants.id} IN (${unprovisionedTenantId}, ${revokedTenantId}, ${readyTenantId}, ${shopBoundTenantId}, ${installLinkTenantId})`,
      );
    await raw.close();
  });

  it("refuses an unprovisioned tenant with 403 (no global fallback)", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?shop=${blockedShop}&grant=${grant(unprovisionedTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "shopify_provisioning_required",
      reason: "not_provisioned",
    });
  });

  it("refuses a revoked tenant with 403 (reason revoked)", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?shop=${blockedShop}&grant=${grant(revokedTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "shopify_provisioning_required",
      reason: "revoked",
    });
  });

  it("refuses the no-shop store-picker path for an unprovisioned tenant", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?grant=${grant(unprovisionedTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("shopify_provisioning_required");
  });

  it("redirects a provisioned tenant to its OWN app (pilot-client), not the global app", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?shop=gate-ready-uniq.myshopify.com&grant=${grant(readyTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("client_id=pilot-client");
    expect(location).not.toContain("global-client");
  });

  // A4 — no ?shop= param, but the tenant was provisioned WITH a store domain,
  // so the install goes straight to that shop's standard OAuth authorize URL
  // (not the unverified admin.shopify.com managed-install store picker).
  it("uses the provisioned shop's authorize URL for a no-shop install", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?grant=${grant(shopBoundTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`https://${boundShop}/admin/oauth/authorize`);
    expect(location).toContain("client_id=pilot-client");
    expect(location).not.toContain("admin.shopify.com");
  });

  // Store-unique install link: when the operator pasted the link Shopify
  // generated for this store, the no-shop Connect redirects straight to it
  // instead of building our own OAuth authorize URL.
  it("redirects a no-shop install to the operator's store-unique install link", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?grant=${grant(installLinkTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(storeInstallLink);
  });

  // F1 — a no-shop install for a pilot tenant whose row has NO recorded shop
  // must be refused, not redirected to the admin.shopify.com managed-install
  // store picker: that picker's re-entry needs the global app secret to verify
  // its HMAC, which pure-pilot mode forbids, so it dead-ends at 400. The fix
  // refuses up front (new provisioning requires a shop; this guards legacy rows
  // like readyTenantId, which was provisioned without one).
  it("refuses a no-shop install when the pilot row has no recorded shop (F1)", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?grant=${grant(readyTenantId)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "shopify_provisioning_required",
      reason: "shop_not_recorded",
    });
  });
});
