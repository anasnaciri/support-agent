import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { CaseId, TenantId } from "@support-agent/agent-core";
import {
  ImageHashStore,
  ImageHashStoreTest,
  matchSimilar,
} from "../src/index.js";

const tenant = TenantId("11111111-1111-1111-1111-111111111111");
const otherTenant = TenantId("22222222-2222-2222-2222-222222222222");
const caseA = CaseId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const caseB = CaseId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

const run = <A>(eff: Effect.Effect<A, unknown, ImageHashStore>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, ImageHashStoreTest) as Effect.Effect<A>);

describe("ImageHashStoreTest", () => {
  it("returns a near match (within Hamming distance) from another case", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, caseId: caseA, phash: 0b1010n });
        return yield* store.findSimilar({
          tenantId: tenant,
          caseId: caseB,
          phash: 0b1011n, // distance 1 from caseA's hash
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.caseId).toBe(caseA);
    expect(hits[0]?.distance).toBe(1);
  });

  it("excludes the originating case (a photo never matches itself)", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, caseId: caseA, phash: 42n });
        return yield* store.findSimilar({
          tenantId: tenant,
          caseId: caseA,
          phash: 42n,
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it("does not match across tenants", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({
          tenantId: otherTenant,
          caseId: caseA,
          phash: 7n,
        });
        return yield* store.findSimilar({
          tenantId: tenant,
          caseId: caseB,
          phash: 7n,
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it("ignores hashes beyond the distance threshold", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, caseId: caseA, phash: 0n });
        return yield* store.findSimilar({
          tenantId: tenant,
          caseId: caseB,
          phash: 0xffn, // distance 8 > maxDistance 5
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });
});

describe("matchSimilar", () => {
  it("filters out rows older than the window and sorts nearest-first", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const recent = new Date("2026-05-20T00:00:00.000Z"); // 12 days ago
    const old = new Date("2026-01-01T00:00:00.000Z"); // >90 days ago
    const hits = matchSimilar(
      [
        { tenantId: tenant, caseId: caseA, phash: 0b1110n, createdAt: recent },
        { tenantId: tenant, caseId: caseB, phash: 0b1010n, createdAt: recent },
        { tenantId: tenant, caseId: caseA, phash: 0b1010n, createdAt: old },
      ],
      {
        tenantId: tenant,
        caseId: CaseId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
        phash: 0b1010n,
        maxDistance: 5,
        sinceDays: 90,
        now,
      },
    );
    // The old row is excluded; caseB (distance 0) sorts before caseA (distance 1).
    expect(hits.map((h) => h.caseId)).toEqual([caseB, caseA]);
    expect(hits[0]?.distance).toBe(0);
  });
});
