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
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

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
    dashboardApiToken: null,
    adminApiToken: null,
    shopifyConnectRequiresProvisioning: true,
  } as ApiConfig;

  let pilot: ServerHandle | null = null;
  let pilotUrl = "";

  const provisioningLayer = ShopifyAppProvisioningStoreLive(encryptionKey).pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

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
    for (const id of [unprovisionedTenantId, revokedTenantId, readyTenantId]) {
      await raw.db
        .insert(tenants)
        .values({ id, name: `install-gate-${id.slice(0, 6)}`, settings: acceptedSettings });
    }
    await provision(revokedTenantId);
    await revoke(revokedTenantId);
    await provision(readyTenantId);

    pilot = await startServer(pilotCfg);
    pilotUrl = `http://localhost:${pilot.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (pilot) await pilot.close();
    await raw.db
      .delete(tenants)
      .where(
        sql`${tenants.id} IN (${unprovisionedTenantId}, ${revokedTenantId}, ${readyTenantId})`,
      );
    await raw.close();
  });

  it("refuses an unprovisioned tenant with 403 (no global fallback)", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?shop=acme.myshopify.com&tenant=${unprovisionedTenantId}`,
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
      `${pilotUrl}/shopify/install?shop=acme.myshopify.com&tenant=${revokedTenantId}`,
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
      `${pilotUrl}/shopify/install?tenant=${unprovisionedTenantId}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("shopify_provisioning_required");
  });

  it("redirects a provisioned tenant to its OWN app (pilot-client), not the global app", async () => {
    const res = await fetch(
      `${pilotUrl}/shopify/install?shop=acme.myshopify.com&tenant=${readyTenantId}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("client_id=pilot-client");
    expect(location).not.toContain("global-client");
  });
});
