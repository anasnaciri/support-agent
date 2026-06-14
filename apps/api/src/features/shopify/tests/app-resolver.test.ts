import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  ShopifyAppProvisioningStore,
  ShopifyAppProvisioningStoreTest,
  type ShopifyAppProvisioning,
} from "@support-agent/services";
import {
  resolveShopifyAppForShop,
  resolveShopifyAppForTenant,
  type GlobalShopifyApp,
} from "../app-resolver.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const globalApp: GlobalShopifyApp = {
  clientId: "global_client",
  clientSecret: "global_secret",
};

const seedRow = (
  overrides: Partial<ShopifyAppProvisioning> = {},
): ShopifyAppProvisioning => ({
  tenantId: TenantId(tenantId),
  clientId: "tenant_client",
  clientSecret: "tenant_secret",
  shopDomain: "pilot.myshopify.com",
  status: "connected",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const runExit = <A, E>(
  eff: Effect.Effect<A, E, ShopifyAppProvisioningStore>,
  seed: ReadonlyArray<ShopifyAppProvisioning>,
) =>
  Effect.runPromiseExit(
    Effect.provide(eff, ShopifyAppProvisioningStoreTest(seed)),
  );

describe("shopify-app-resolver — by tenant (install path)", () => {
  it("uses the per-tenant app when a provisioning row exists", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp, {
        requireProvisioning: false,
      }),
      [seedRow()],
    );
    expect(exit).toStrictEqual(
      Exit.succeed({
        clientId: "tenant_client",
        clientSecret: "tenant_secret",
        source: "tenant",
      }),
    );
  });

  it("falls back to the global app when no row exists (SaaS mode)", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp, {
        requireProvisioning: false,
      }),
      [],
    );
    expect(exit).toStrictEqual(
      Exit.succeed({
        clientId: "global_client",
        clientSecret: "global_secret",
        source: "global",
      }),
    );
  });

  it("fails ShopifyAppNotConfigured when neither a row nor a global app exists", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), null, {
        requireProvisioning: false,
      }),
      [],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyAppNotConfigured");
  });

  // A1 — pilot gate must be enforced on the install path, not just the
  // dashboard overview. With no provisioning row, refuse rather than fall
  // back to the global app.
  it("refuses install (ShopifyProvisioningRequired) with no row when provisioning is required, even with a global app", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp, {
        requireProvisioning: true,
      }),
      [],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyProvisioningRequired");
  });

  // A2 — a revoked provisioning row is not installable. It must NOT silently
  // fall back to the global app either (the tenant is a pilot tenant on its
  // own app); webhook verification uses a separate path that still resolves
  // the revoked secret.
  it("refuses install on a revoked row, even with a global app, in SaaS mode", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp, {
        requireProvisioning: false,
      }),
      [seedRow({ status: "revoked" })],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyProvisioningRequired");
  });

  it("refuses install on a revoked row in pilot mode", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), null, {
        requireProvisioning: true,
      }),
      [seedRow({ status: "revoked" })],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyProvisioningRequired");
  });

  it("uses the per-tenant app for a ready row in pilot mode", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), null, {
        requireProvisioning: true,
      }),
      [seedRow({ status: "ready" })],
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.source).toBe("tenant");
    }
  });
});

describe("shopify-app-resolver — by shop", () => {
  it("uses the per-tenant app when a row matches the shop domain", async () => {
    const exit = await runExit(
      resolveShopifyAppForShop("pilot.myshopify.com", globalApp),
      [seedRow()],
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.clientSecret).toBe("tenant_secret");
      expect(exit.value.source).toBe("tenant");
    }
  });

  it("falls back to the global app when no row matches the shop", async () => {
    const exit = await runExit(
      resolveShopifyAppForShop("unknown.myshopify.com", globalApp),
      [seedRow()],
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.clientSecret).toBe("global_secret");
      expect(exit.value.source).toBe("global");
    }
  });

  it("resolves even a revoked row to its tenant credentials (webhook still verifies)", async () => {
    const exit = await runExit(
      resolveShopifyAppForShop("pilot.myshopify.com", globalApp),
      [seedRow({ status: "revoked" })],
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.source).toBe("tenant");
    }
  });

  it("fails for an unknown shop when no global app is configured", async () => {
    const exit = await runExit(
      resolveShopifyAppForShop("unknown.myshopify.com", null),
      [],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyAppNotConfigured");
  });
});
