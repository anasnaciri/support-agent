import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import { ShopifyAppProvisioningStore } from "@support-agent/services";
import {
  DbClient,
  DbClientLive,
  ShopifyAppProvisioningStoreLive,
  makeDbClient,
  shopifyAppProvisioning,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ShopifyAppProvisioningStore (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const blankTenantId = randomUUID();
  const encryptionKey = randomBytes(32);

  const liveLayer = Layer.provide(
    ShopifyAppProvisioningStoreLive(encryptionKey),
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const run = <A, E>(
    eff: Effect.Effect<A, E, ShopifyAppProvisioningStore | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "pilot-test" });
    await raw.db
      .insert(tenants)
      .values({ id: blankTenantId, name: "pilot-test-blank" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(shopifyAppProvisioning)
      .where(sql`${shopifyAppProvisioning.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${blankTenantId}`);
    await raw.close();
  });

  it("put → get round-trips an encrypted client_secret", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          clientId: "shopify_client_abc",
          clientSecret: "shpss_super_secret",
        });
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.clientId).toBe("shopify_client_abc");
    expect(fetched!.clientSecret).toBe("shpss_super_secret");
    expect(fetched!.shopDomain).toBeNull();
    expect(fetched!.installLink).toBeNull();
    expect(fetched!.status).toBe("ready");
  });

  it("put records and round-trips the install_link", async () => {
    const link =
      "https://admin.shopify.com/store/pilot/oauth/install_custom_app?client_id=shopify_client_abc";
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          clientId: "shopify_client_abc",
          clientSecret: "shpss_super_secret",
          installLink: link,
        });
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched!.installLink).toBe(link);
  });

  it("put without an install_link preserves the recorded one on a live row", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          clientId: "shopify_client_abc2",
          clientSecret: "shpss_super_secret2",
        });
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched!.installLink).toBe(
      "https://admin.shopify.com/store/pilot/oauth/install_custom_app?client_id=shopify_client_abc",
    );
  });

  it("get returns null for a tenant with no provisioning row", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        return yield* store.get(TenantId(blankTenantId));
      }),
    );
    expect(fetched).toBeNull();
  });

  it("stores the secret encrypted at rest (not plaintext)", async () => {
    if (!raw) return;
    const rows = await raw.db
      .select()
      .from(shopifyAppProvisioning)
      .where(sql`${shopifyAppProvisioning.tenantId} = ${tenantId}`);
    const stored = rows[0]!.clientSecretEncrypted;
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(stored.toString("utf8")).not.toContain("shpss_super_secret");
  });

  it("markConnected stamps shop_domain + status, resolvable by shop", async () => {
    const byShop = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.markConnected(
          TenantId(tenantId),
          "pilot-store.myshopify.com",
        );
        return yield* store.getByShop("pilot-store.myshopify.com");
      }),
    );
    expect(byShop).not.toBeNull();
    expect(byShop!.tenantId).toBe(tenantId);
    expect(byShop!.shopDomain).toBe("pilot-store.myshopify.com");
    expect(byShop!.status).toBe("connected");
  });

  it("put rotates credentials but preserves shop_domain + connected status", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          clientId: "shopify_client_rotated",
          clientSecret: "shpss_rotated_secret",
        });
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched!.clientId).toBe("shopify_client_rotated");
    expect(fetched!.clientSecret).toBe("shpss_rotated_secret");
    expect(fetched!.shopDomain).toBe("pilot-store.myshopify.com");
    expect(fetched!.status).toBe("connected");
  });

  it("revoke flips status to revoked and reports a row was affected", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        const revoked = yield* store.revoke(TenantId(tenantId));
        const row = yield* store.get(TenantId(tenantId));
        return { revoked, row };
      }),
    );
    expect(result.revoked).toBe(true);
    expect(result.row!.status).toBe("revoked");
  });

  it("revoke returns false when no provisioning row exists (5th-audit #2)", async () => {
    const revoked = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        return yield* store.revoke(TenantId(blankTenantId));
      }),
    );
    expect(revoked).toBe(false);
  });

  it("put reactivates a revoked row back to ready and clears the stale shop_domain (A2/A3)", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        // Row is `revoked` from the previous test. Re-entering credentials
        // must un-block the install by resetting status to `ready`, and the
        // stale shop_domain is cleared so it can't collide with the
        // active-shop unique index — the merchant re-stamps it on Connect.
        yield* store.put({
          tenantId: TenantId(tenantId),
          clientId: "shopify_client_reactivated",
          clientSecret: "shpss_reactivated_secret",
        });
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched!.status).toBe("ready");
    expect(fetched!.clientId).toBe("shopify_client_reactivated");
    expect(fetched!.shopDomain).toBeNull();
    // The stale install link is dropped alongside the shop on reactivation.
    expect(fetched!.installLink).toBeNull();
  });
});

describeIfDb(
  "ShopifyAppProvisioningStore (Live) — deterministic shop routing (A3)",
  () => {
    const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const encryptionKey = randomBytes(32);
    const shop = "transfer-shop.myshopify.com";

    const liveLayer = Layer.provide(
      ShopifyAppProvisioningStoreLive(encryptionKey),
      DbClientLive({ databaseUrl: databaseUrl! }),
    );
    const run = <A, E>(
      eff: Effect.Effect<A, E, ShopifyAppProvisioningStore | DbClient>,
    ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

    beforeAll(async () => {
      if (!raw) return;
      await raw.db.insert(tenants).values({ id: tenantA, name: "transfer-a" });
      await raw.db.insert(tenants).values({ id: tenantB, name: "transfer-b" });
    });

    afterAll(async () => {
      if (!raw) return;
      await raw.db
        .delete(shopifyAppProvisioning)
        .where(sql`${shopifyAppProvisioning.tenantId} IN (${tenantA}, ${tenantB})`);
      await raw.db
        .delete(tenants)
        .where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
      await raw.close();
    });

    it("transferring a shop to a new tenant clears the prior row and routes to the new owner — no unique-index violation", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* ShopifyAppProvisioningStore;
          // Tenant A provisions + connects the shop.
          yield* store.put({
            tenantId: TenantId(tenantA),
            clientId: "client-a",
            clientSecret: "secret-a",
          });
          yield* store.markConnected(TenantId(tenantA), shop);
          // Shop transfers: tenant B provisions + connects the SAME shop.
          // This must not violate the active-shop unique index.
          yield* store.put({
            tenantId: TenantId(tenantB),
            clientId: "client-b",
            clientSecret: "secret-b",
          });
          yield* store.markConnected(TenantId(tenantB), shop);
          const routed = yield* store.getByShop(shop);
          const a = yield* store.get(TenantId(tenantA));
          return { routed, a };
        }),
      );
      // Webhook routing now resolves to tenant B (the live owner).
      expect(result.routed!.tenantId).toBe(tenantB);
      expect(result.routed!.clientSecret).toBe("secret-b");
      // Tenant A's row kept its credentials but no longer holds the shop.
      expect(result.a!.shopDomain).toBeNull();
    });
  },
);
