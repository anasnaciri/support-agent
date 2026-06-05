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
} from "../src/shopify-app-resolver.js";

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

describe("shopify-app-resolver — by tenant", () => {
  it("uses the per-tenant app when a provisioning row exists", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp),
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

  it("falls back to the global app when no row exists", async () => {
    const exit = await runExit(
      resolveShopifyAppForTenant(TenantId(tenantId), globalApp),
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
      resolveShopifyAppForTenant(TenantId(tenantId), null),
      [],
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("ShopifyAppNotConfigured");
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
