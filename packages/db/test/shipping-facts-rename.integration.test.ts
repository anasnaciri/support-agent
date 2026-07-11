import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TenantId } from "@support-agent/agent-core";
import { TenantRepository } from "@support-agent/services";
import {
  DbClientLive,
  makeDbClient,
  TenantRepositoryLive,
  tenants,
} from "../src/index.js";

// Pins migration 0046, which moves the `shippingProfile` block of
// `tenants.settings` to `shippingFacts`. The test DB is already migrated, so a
// row seeded here with the OLD key would never be touched by the migrator —
// the test therefore runs the migration's own SQL against the seeded row. That
// keeps the assertion honest: if someone edits the migration into something
// that drops a merchant's saved shipping facts, this fails.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL("../migrations/0046_shipping_facts_rename.sql", import.meta.url),
  ),
  "utf8",
);

const legacyBlock = {
  processingTime: "1–2 business days",
  deliveryTime: "7–12 days",
  shippingCost: "Free over $50",
  customsDuties: "customer",
  delayedAfterDays: 14,
  lostPackageInvestigationDays: 30,
};

describeIfDb("migration 0046 — shippingProfile → shippingFacts", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seeded: string[] = [];

  afterAll(async () => {
    if (seeded.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seeded));
    }
    await client.close();
  });

  const layer = TenantRepositoryLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const seedTenant = async (
    settings: Record<string, unknown>,
  ): Promise<TenantId> => {
    const id = randomUUID();
    await db
      .insert(tenants)
      .values({ id, name: "Shipping Facts Rename Test", settings });
    seeded.push(id);
    return TenantId(id);
  };

  /**
   * Run the migration's statements exactly as the migrator would. Safe to run
   * against the shared test DB and safe to re-run: it is idempotent, and the
   * migrator has already cleared the legacy key from every pre-existing row, so
   * the only rows left for it to touch are the ones seeded above.
   */
  const runMigration = async () => {
    for (const stmt of MIGRATION_SQL.split("--> statement-breakpoint")) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  };

  const readSettings = (tenantId: TenantId) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );

  const rawSettings = async (tenantId: TenantId) => {
    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(inArray(tenants.id, [tenantId]));
    return rows[0]!.settings as Record<string, unknown>;
  };

  it("carries a pre-rename block over to the new key, value-for-value", async () => {
    const tenantId = await seedTenant({
      notificationEmail: "ops@example.com",
      shippingProfile: legacyBlock,
    });

    // Before: the renamed code cannot see the legacy key at all.
    expect((await readSettings(tenantId)).shippingFacts).toBeNull();

    await runMigration();

    // After: same values, new key, and the old key is gone.
    expect((await readSettings(tenantId)).shippingFacts).toEqual(legacyBlock);
    const raw = await rawSettings(tenantId);
    expect(raw["shippingFacts"]).toEqual(legacyBlock);
    expect(raw).not.toHaveProperty("shippingProfile");
    // Unrelated settings survive the jsonb surgery.
    expect(raw["notificationEmail"]).toBe("ops@example.com");
  });

  it("keeps the new key when a row somehow carries both, and drops the old one", async () => {
    const tenantId = await seedTenant({
      shippingProfile: { ...legacyBlock, deliveryTime: "STALE" },
      shippingFacts: legacyBlock,
    });

    await runMigration();

    const raw = await rawSettings(tenantId);
    expect(raw["shippingFacts"]).toEqual(legacyBlock);
    expect(raw).not.toHaveProperty("shippingProfile");
  });

  it("leaves a tenant that never configured shipping facts untouched", async () => {
    const tenantId = await seedTenant({ notificationEmail: "ops@example.com" });

    await runMigration();

    expect((await readSettings(tenantId)).shippingFacts).toBeNull();
    expect(await rawSettings(tenantId)).toEqual({
      notificationEmail: "ops@example.com",
    });
  });
});
