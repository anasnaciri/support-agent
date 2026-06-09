import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  KnowledgeBaseService,
  KnowledgeBaseServiceTest,
} from "../src/knowledge-base.js";

const tenantA = TenantId("00000000-0000-0000-0000-0000000000aa");
const tenantB = TenantId("00000000-0000-0000-0000-0000000000bb");

const run = <A>(
  eff: (s: typeof KnowledgeBaseService.Service) => Effect.Effect<A>,
  layer = KnowledgeBaseServiceTest(),
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(KnowledgeBaseService, (s) => eff(s)),
      layer,
    ),
  );

describe("KnowledgeBaseServiceTest", () => {
  it("returns empty reads for a tenant with no documents", async () => {
    expect(await run((s) => s.list(tenantA))).toEqual([]);
    expect(await run((s) => s.listTitles(tenantA))).toEqual([]);
    expect(await run((s) => s.count(tenantA))).toBe(0);
  });

  it("creates a document and reads it back in full via get", async () => {
    const doc = await run((s) =>
      Effect.gen(function* () {
        const created = yield* s.create(tenantA, {
          title: "Shipping policy",
          content: "We ship in 3 days.",
          sourceType: "text",
          sourceUrl: null,
          contentHash: "h1",
          fetchedAt: null,
        });
        return yield* s.get(tenantA, created.id);
      }),
    );
    expect(doc).toMatchObject({
      title: "Shipping policy",
      content: "We ship in 3 days.",
      sourceType: "text",
      sourceUrl: null,
    });
  });

  it("lists summaries (without content) and titles", async () => {
    const layer = KnowledgeBaseServiceTest();
    const { summaries, titles } = await run(
      (s) =>
        Effect.gen(function* () {
          yield* s.create(tenantA, {
            title: "Shipping policy",
            content: "ship text",
            sourceType: "text",
            sourceUrl: null,
            contentHash: null,
            fetchedAt: null,
          });
          yield* s.create(tenantA, {
            title: "Returns policy",
            content: "returns text",
            sourceType: "url",
            sourceUrl: "https://shop.example/returns",
            contentHash: "h",
            fetchedAt: new Date("2026-06-09T00:00:00Z"),
          });
          const summaries = yield* s.list(tenantA);
          const titles = yield* s.listTitles(tenantA);
          return { summaries, titles };
        }),
      layer,
    );
    expect(titles).toEqual(["Shipping policy", "Returns policy"]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toHaveProperty("content");
    expect(summaries[1]).toMatchObject({
      title: "Returns policy",
      sourceType: "url",
      sourceUrl: "https://shop.example/returns",
    });
  });

  it("listFull returns full documents with content (for the search tool)", async () => {
    const docs = await run((s) =>
      Effect.gen(function* () {
        yield* s.create(tenantA, {
          title: "FAQ",
          content: "the full body",
          sourceType: "text",
          sourceUrl: null,
          contentHash: null,
          fetchedAt: null,
        });
        return yield* s.listFull(tenantA);
      }),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]?.content).toBe("the full body");
  });

  it("updates fields and bumps updatedAt", async () => {
    const { before, after } = await run((s) =>
      Effect.gen(function* () {
        const created = yield* s.create(tenantA, {
          title: "Old",
          content: "old body",
          sourceType: "text",
          sourceUrl: null,
          contentHash: "old",
          fetchedAt: null,
        });
        const updated = yield* s.update(tenantA, created.id, {
          title: "New",
          content: "new body",
          contentHash: "new",
        });
        return { before: created, after: updated };
      }),
    );
    expect(after).toMatchObject({ title: "New", content: "new body" });
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
  });

  it("removes a document", async () => {
    const { removed, afterGet } = await run((s) =>
      Effect.gen(function* () {
        const created = yield* s.create(tenantA, {
          title: "Doomed",
          content: "x",
          sourceType: "text",
          sourceUrl: null,
          contentHash: null,
          fetchedAt: null,
        });
        const removed = yield* s.remove(tenantA, created.id);
        const afterGet = yield* s.get(tenantA, created.id);
        return { removed, afterGet };
      }),
    );
    expect(removed).toBe(true);
    expect(afterGet).toBeNull();
  });

  it("is tenant-scoped: B cannot read, update, or remove A's document", async () => {
    const out = await run((s) =>
      Effect.gen(function* () {
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
          bList: yield* s.list(tenantB),
          // A still intact
          aGet: yield* s.get(tenantA, a.id),
        };
      }),
    );
    expect(out.bGet).toBeNull();
    expect(out.bUpdate).toBeNull();
    expect(out.bRemove).toBe(false);
    expect(out.bList).toEqual([]);
    expect(out.aGet).toMatchObject({ title: "A-only" });
  });
});
