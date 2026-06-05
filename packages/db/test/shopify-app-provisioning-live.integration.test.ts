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
    expect(fetched!.status).toBe("ready");
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

  it("revoke flips status to revoked", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        yield* store.revoke(TenantId(tenantId));
        return yield* store.get(TenantId(tenantId));
      }),
    );
    expect(fetched!.status).toBe("revoked");
  });
});
