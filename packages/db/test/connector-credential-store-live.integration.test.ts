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

  // The active-shopify and active-mailbox unique indexes are keyed on
  // (provider, shop_domain) with NO tenant column — deliberately, since a shop
  // or mailbox can be actively connected to only ONE tenant. So a fixed test
  // domain is a shared global key: a run killed mid-suite leaves an active row
  // that collides with the NEXT run's insert even though each run uses a fresh
  // tenant (the "connector-test debris" flake). Per-run-unique domains close it
  // — a leaked active row is stranded on a domain no later run ever writes.
  const tag = randomUUID().slice(0, 8);
  const shop = (label: string) => `${label}-${tag}.myshopify.com`;
  const mbox = (label: string) => `${label}+${tag}@example.com`;
  const DEMO = shop("demo-store");
  const NO_SUCH = shop("no-such");
  const DOOMED = shop("doomed-store");
  const ROTATE = shop("rotate");
  const MB_WRONG = mbox("wrong-mailbox");
  const MB_RIGHT = mbox("right-mailbox");
  const MB_GONE = mbox("gone-mailbox");
  const MB_ONLY_A = mbox("only-a");

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
          shopDomain: DEMO,
          accessToken: "shpoa_super_secret",
          scopes: ["read_orders", "read_customers"],
          apiVersion: "2025-01",
        });
        return yield* store.get(TenantId(tenantId), "shopify", DEMO);
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
        sql`${connectorConnections.tenantId} = ${tenantId} AND ${connectorConnections.shopDomain} = ${DEMO}`,
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
          shopDomain: DEMO,
          accessToken: "shpoa_rotated",
          scopes: ["read_orders"],
          apiVersion: "2025-04",
        });
        return yield* store.get(TenantId(tenantId), "shopify", DEMO);
      }),
    );
    expect(fetched.accessToken).toBe("shpoa_rotated");
    expect(fetched.scopes).toEqual(["read_orders"]);
    expect(fetched.apiVersion).toBe("2025-04");

    const rows = await raw!.db
      .select()
      .from(connectorConnections)
      .where(
        sql`${connectorConnections.tenantId} = ${tenantId} AND ${connectorConnections.shopDomain} = ${DEMO}`,
      );
    // Still exactly one row — upsert, not insert.
    expect(rows).toHaveLength(1);
  });

  it("get for a missing connector → ConnectorNotFound", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(TenantId(otherTenantId), "shopify", NO_SUCH);
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
          shopDomain: DOOMED,
          accessToken: "shpoa_doomed",
          scopes: ["read_orders"],
        });
        yield* store.revoke(TenantId(otherTenantId), "shopify", DOOMED);
        return yield* store.get(TenantId(otherTenantId), "shopify", DOOMED);
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
          shopDomain: MB_WRONG,
          accessToken: "tok_wrong",
          scopes: ["Mail.ReadWrite"],
        });
        yield* store.revoke(TenantId(tenantId), "outlook", MB_WRONG);
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "outlook",
          shopDomain: MB_RIGHT,
          accessToken: "tok_right",
          scopes: ["Mail.ReadWrite"],
        });
        return yield* store.get(TenantId(tenantId), "outlook");
      }),
    );
    expect(fetched.shopDomain).toBe(MB_RIGHT);
    expect(fetched.status).toBe("active");
  });

  it("get without shopDomain when only revoked rows exist → ConnectorRevoked", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(otherTenantId),
          provider: "outlook",
          shopDomain: MB_GONE,
          accessToken: "tok_gone",
          scopes: ["Mail.ReadWrite"],
        });
        yield* store.revoke(TenantId(otherTenantId), "outlook", MB_GONE);
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
      list.some((r) => r.shopDomain === DEMO),
    ).toBe(true);
  });

  // Audit S15 — key rotation. A token written under key A must still decrypt
  // after the operator rolls a new primary key B in (set = [B, A]); and a store
  // built with ONLY the new key must fail to read the old ciphertext.
  describe("key rotation (audit S15)", () => {
    const rotationTenant = randomUUID();
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);

    const storeWith = (keys: ReadonlyArray<Buffer>) =>
      Layer.provide(
        ConnectorCredentialStoreLive(keys),
        DbClientLive({ databaseUrl: databaseUrl! }),
      );
    const runWith = <A, E>(
      keys: ReadonlyArray<Buffer>,
      eff: Effect.Effect<A, E, ConnectorCredentialStore | DbClient>,
    ) =>
      Effect.runPromiseExit(
        Effect.provide(eff, storeWith(keys)).pipe(Effect.scoped),
      );

    beforeAll(async () => {
      if (!raw) return;
      await raw.db
        .insert(tenants)
        .values({ id: rotationTenant, name: "connector-test-rotation" });
    });

    afterAll(async () => {
      if (!raw) return;
      await raw.db
        .delete(connectorConnections)
        .where(sql`${connectorConnections.tenantId} = ${rotationTenant}`);
      await raw.db
        .delete(tenants)
        .where(sql`${tenants.id} = ${rotationTenant}`);
    });

    it("reads a token written under key A through the set [B, A]", async () => {
      // Write under the OLD key A.
      const wrote = await runWith(
        [keyA],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId: TenantId(rotationTenant),
            provider: "shopify",
            shopDomain: ROTATE,
            accessToken: "shpoa_pre_rotation",
            scopes: ["read_orders"],
          });
          return true;
        }),
      );
      expect(Exit.isSuccess(wrote)).toBe(true);

      // Roll the new key B in as primary, A as previous. Read must succeed.
      const fetched = await runWith(
        [keyB, keyA],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.get(
            TenantId(rotationTenant),
            "shopify",
            ROTATE,
          );
        }),
      );
      expect(Exit.isSuccess(fetched)).toBe(true);
      if (Exit.isSuccess(fetched)) {
        expect(fetched.value.accessToken).toBe("shpoa_pre_rotation");
      }
    });

    it("re-encrypts to the new key on next write so [B] alone then reads it", async () => {
      // Touch the row through the set [B, A] — the write re-encrypts under B.
      const rewrote = await runWith(
        [keyB, keyA],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.patchTokens({
            tenantId: TenantId(rotationTenant),
            provider: "shopify",
            shopDomain: ROTATE,
            accessToken: "shpoa_post_rotation",
            tokenExpiresAt: null,
          });
          return true;
        }),
      );
      expect(Exit.isSuccess(rewrote)).toBe(true);

      // Key B alone now decrypts the migrated row.
      const fetched = await runWith(
        [keyB],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.get(
            TenantId(rotationTenant),
            "shopify",
            ROTATE,
          );
        }),
      );
      expect(Exit.isSuccess(fetched)).toBe(true);
      if (Exit.isSuccess(fetched)) {
        expect(fetched.value.accessToken).toBe("shpoa_post_rotation");
      }
    });

    it("fails to read an A-encrypted token with the new key B alone", async () => {
      // Write a fresh row under A, then attempt a read with only B — no
      // fallback, so decryption fails (surfaces as a store DB error).
      await runWith(
        [keyA],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId: TenantId(rotationTenant),
            provider: "outlook",
            shopDomain: MB_ONLY_A,
            accessToken: "tok_only_a",
            scopes: ["Mail.ReadWrite"],
          });
          return true;
        }),
      );

      const exit = await runWith(
        [keyB],
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.get(
            TenantId(rotationTenant),
            "outlook",
            MB_ONLY_A,
          );
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
