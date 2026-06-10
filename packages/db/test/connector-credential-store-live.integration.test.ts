import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Exit, Layer } from "effect";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConnectorNotFound,
  ConnectorRevoked,
  TenantId,
} from "@support-agent/agent-core";
import { ConnectorCredentialStore } from "@support-agent/services";
import {
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
  connectorConnections,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ConnectorCredentialStore (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const encryptionKey = randomBytes(32);

  const liveLayer = Layer.provide(
    ConnectorCredentialStoreLive(encryptionKey),
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const run = <A, E>(
    eff: Effect.Effect<A, E, ConnectorCredentialStore | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runExit = <A, E>(
    eff: Effect.Effect<A, E, ConnectorCredentialStore | DbClient>,
  ) =>
    Effect.runPromiseExit(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "connector-test" });
    await raw.db
      .insert(tenants)
      .values({ id: otherTenantId, name: "connector-test-other" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(connectorConnections)
      .where(sql`${connectorConnections.tenantId} = ${tenantId}`);
    await raw.db
      .delete(connectorConnections)
      .where(sql`${connectorConnections.tenantId} = ${otherTenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${otherTenantId}`);
    await raw.close();
  });

  it("put → get round-trips an encrypted token", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "shopify",
          shopDomain: "demo-store.myshopify.com",
          accessToken: "shpoa_super_secret",
          scopes: ["read_orders", "read_customers"],
          apiVersion: "2025-01",
        });
        return yield* store.get(
          TenantId(tenantId),
          "shopify",
          "demo-store.myshopify.com",
        );
      }),
    );
    expect(fetched.accessToken).toBe("shpoa_super_secret");
    expect(fetched.scopes).toEqual(["read_orders", "read_customers"]);
    expect(fetched.apiVersion).toBe("2025-01");
    expect(fetched.status).toBe("active");
  });

  it("token column stored is NOT plaintext (encryption applied on write)", async () => {
    const rows = await raw!.db
      .select()
      .from(connectorConnections)
      .where(
        sql`${connectorConnections.tenantId} = ${tenantId} AND ${connectorConnections.shopDomain} = 'demo-store.myshopify.com'`,
      );
    expect(rows).toHaveLength(1);
    const blob = rows[0]!.accessTokenEncrypted;
    expect(Buffer.isBuffer(blob) || blob instanceof Uint8Array).toBe(true);
    // The plaintext should not appear in the bytea — confirms we're not
    // accidentally storing it raw.
    expect(blob.includes(Buffer.from("shpoa_super_secret"))).toBe(false);
    // 12-byte IV + 16-byte tag = 28 bytes of header before ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(28);
  });

  it("put upserts: a second put for the same (tenant, provider, shop) updates the row in place", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "shopify",
          shopDomain: "demo-store.myshopify.com",
          accessToken: "shpoa_rotated",
          scopes: ["read_orders"],
          apiVersion: "2025-04",
        });
        return yield* store.get(
          TenantId(tenantId),
          "shopify",
          "demo-store.myshopify.com",
        );
      }),
    );
    expect(fetched.accessToken).toBe("shpoa_rotated");
    expect(fetched.scopes).toEqual(["read_orders"]);
    expect(fetched.apiVersion).toBe("2025-04");

    const rows = await raw!.db
      .select()
      .from(connectorConnections)
      .where(
        sql`${connectorConnections.tenantId} = ${tenantId} AND ${connectorConnections.shopDomain} = 'demo-store.myshopify.com'`,
      );
    // Still exactly one row — upsert, not insert.
    expect(rows).toHaveLength(1);
  });

  it("get for a missing connector → ConnectorNotFound", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(
          TenantId(otherTenantId),
          "shopify",
          "no-such.myshopify.com",
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ConnectorNotFound);
    }
  });

  it("revoke flips status; subsequent get → ConnectorRevoked", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(otherTenantId),
          provider: "shopify",
          shopDomain: "doomed-store.myshopify.com",
          accessToken: "shpoa_doomed",
          scopes: ["read_orders"],
        });
        yield* store.revoke(
          TenantId(otherTenantId),
          "shopify",
          "doomed-store.myshopify.com",
        );
        return yield* store.get(
          TenantId(otherTenantId),
          "shopify",
          "doomed-store.myshopify.com",
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ConnectorRevoked);
    }
  });

  it("get without shopDomain prefers the active row over a revoked sibling", async () => {
    // Regression: a tenant reconnects a provider under a different account
    // (e.g. wrong Outlook mailbox first, then the right one). The old row is
    // revoked, the new one active. A bare `get(tenant, provider)` — the shape
    // every webhook handler uses — must resolve the ACTIVE row, not whichever
    // one the database returns first.
    const fetched = await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "outlook",
          shopDomain: "wrong-mailbox@example.com",
          accessToken: "tok_wrong",
          scopes: ["Mail.ReadWrite"],
        });
        yield* store.revoke(
          TenantId(tenantId),
          "outlook",
          "wrong-mailbox@example.com",
        );
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "outlook",
          shopDomain: "right-mailbox@example.com",
          accessToken: "tok_right",
          scopes: ["Mail.ReadWrite"],
        });
        return yield* store.get(TenantId(tenantId), "outlook");
      }),
    );
    expect(fetched.shopDomain).toBe("right-mailbox@example.com");
    expect(fetched.status).toBe("active");
  });

  it("get without shopDomain when only revoked rows exist → ConnectorRevoked", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(otherTenantId),
          provider: "outlook",
          shopDomain: "gone-mailbox@example.com",
          accessToken: "tok_gone",
          scopes: ["Mail.ReadWrite"],
        });
        yield* store.revoke(
          TenantId(otherTenantId),
          "outlook",
          "gone-mailbox@example.com",
        );
        return yield* store.get(TenantId(otherTenantId), "outlook");
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ConnectorRevoked);
    }
  });

  it("listForTenant returns only that tenant's rows", async () => {
    const list = await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(tenantId));
      }),
    );
    // Includes the upserted "demo-store" row, but NOT the doomed row from
    // the other tenant.
    expect(
      list.every((r) => r.tenantId === (tenantId as never)),
    ).toBe(true);
    expect(
      list.some((r) => r.shopDomain === "demo-store.myshopify.com"),
    ).toBe(true);
  });
});
