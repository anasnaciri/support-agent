import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TenantId } from "@support-agent/agent-core";
import { KnowledgeBaseService } from "@support-agent/services";
import {
  DbClientLive,
  KnowledgeBaseServiceLive,
  makeDbClient,
  tenants,
} from "../src/index.js";

// Exercises the real Postgres CRUD + tenant scoping the in-memory Test layer
// can't (returning(), tenant-scoped update/delete → null/false, createdAt
// ordering). Gated on DATABASE_URL.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("KnowledgeBaseServiceLive", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  // Every seeded tenant is tracked and deleted in afterAll; the FK cascade
  // takes its tenant_knowledge_documents with it. Without this, each run
  // leaves a pile of dangling "KB Test" tenants in the database.
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const layer = KnowledgeBaseServiceLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  const run = <A>(eff: Effect.Effect<A, unknown, KnowledgeBaseService>) =>
    Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A>);

  const seedTenant = async (): Promise<TenantId> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "KB Test" });
    seededTenants.push(id);
    return TenantId(id);
  };

  it("creates, reads full, lists summaries (no content), titles + count", async () => {
    const tenantId = await seedTenant();
    const out = await run(
      Effect.gen(function* () {
        const s = yield* KnowledgeBaseService;
        const a = yield* s.create(tenantId, {
          title: "Shipping policy",
          content: "We ship within 3 business days.",
          sourceType: "text",
          sourceUrl: null,
          contentHash: "h-a",
          fetchedAt: null,
        });
        yield* s.create(tenantId, {
          title: "Returns policy",
          content: "30 day returns for a full refund.",
          sourceType: "url",
          sourceUrl: "https://shop.example/returns",
          contentHash: "h-b",
          fetchedAt: new Date("2026-06-09T00:00:00Z"),
        });
        return {
          got: yield* s.get(tenantId, a.id),
          summaries: yield* s.list(tenantId),
          titles: yield* s.listTitles(tenantId),
          count: yield* s.count(tenantId),
        };
      }),
    );
    expect(out.got).toMatchObject({
      title: "Shipping policy",
      content: "We ship within 3 business days.",
      sourceType: "text",
    });
    expect(out.count).toBe(2);
    expect(out.titles).toEqual(["Shipping policy", "Returns policy"]);
    expect(out.summaries).toHaveLength(2);
    expect(out.summaries[0]).not.toHaveProperty("content");
    expect(out.summaries[1]).toMatchObject({
      title: "Returns policy",
      sourceType: "url",
      sourceUrl: "https://shop.example/returns",
    });
  });

  it("listFull returns bodies for the search tool", async () => {
    const tenantId = await seedTenant();
    const docs = await run(
      Effect.gen(function* () {
        const s = yield* KnowledgeBaseService;
        yield* s.create(tenantId, {
          title: "FAQ",
          content: "full faq body",
          sourceType: "text",
          sourceUrl: null,
          contentHash: null,
          fetchedAt: null,
        });
        return yield* s.listFull(tenantId);
      }),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.content).toBe("full faq body");
  });

  it("updates fields on an owned doc", async () => {
    const tenantId = await seedTenant();
    const updated = await run(
      Effect.gen(function* () {
        const s = yield* KnowledgeBaseService;
        const a = yield* s.create(tenantId, {
          title: "Old",
          content: "old",
          sourceType: "text",
          sourceUrl: null,
          contentHash: "old",
          fetchedAt: null,
        });
        return yield* s.update(tenantId, a.id, {
          title: "New",
          content: "new",
          contentHash: "new",
        });
      }),
    );
    expect(updated).toMatchObject({ title: "New", content: "new" });
  });

  it("is tenant-scoped: get/update/remove of another tenant's doc → null/false", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const out = await run(
      Effect.gen(function* () {
        const s = yield* KnowledgeBaseService;
        const a = yield* s.create(tenantA, {
          title: "A-only",
          content: "secret",
          sourceType: "text",
          sourceUrl: null,
          contentHash: null,
          fetchedAt: null,
        });
        return {
          bGet: yield* s.get(tenantB, a.id),
          bUpdate: yield* s.update(tenantB, a.id, { title: "hijack" }),
          bRemove: yield* s.remove(tenantB, a.id),
          aStillThere: yield* s.get(tenantA, a.id),
        };
      }),
    );
    expect(out.bGet).toBeNull();
    expect(out.bUpdate).toBeNull();
    expect(out.bRemove).toBe(false);
    expect(out.aStillThere).toMatchObject({ title: "A-only" });
  });

  it("removes an owned doc", async () => {
    const tenantId = await seedTenant();
    const out = await run(
      Effect.gen(function* () {
        const s = yield* KnowledgeBaseService;
        const a = yield* s.create(tenantId, {
          title: "Doomed",
          content: "x",
          sourceType: "text",
          sourceUrl: null,
          contentHash: null,
          fetchedAt: null,
        });
        const removed = yield* s.remove(tenantId, a.id);
        const after = yield* s.get(tenantId, a.id);
        return { removed, after };
      }),
    );
    expect(out.removed).toBe(true);
    expect(out.after).toBeNull();
  });
});
