import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TicketId, TenantId } from "@support-agent/agent-core";
import {
  ImageHashStore,
  ImageHashStoreTest,
  matchSimilar,
} from "../src/index.js";

const tenant = TenantId("11111111-1111-1111-1111-111111111111");
const otherTenant = TenantId("22222222-2222-2222-2222-222222222222");
const ticketA = TicketId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const ticketB = TicketId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

const run = <A>(eff: Effect.Effect<A, unknown, ImageHashStore>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, ImageHashStoreTest) as Effect.Effect<A>);

describe("ImageHashStoreTest", () => {
  it("returns a near match (within Hamming distance) from another ticket", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 0b1010n });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1011n, // distance 1 from ticketA's hash
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ticketId).toBe(ticketA);
    expect(hits[0]?.distance).toBe(1);
  });

  it("excludes the originating ticket (a photo never matches itself)", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 42n });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketA,
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
          ticketId: ticketA,
          phash: 7n,
        });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
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
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 0n });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0xffn, // distance 8 > maxDistance 5
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it("does NOT flag a near match that belongs to the SAME order", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({
          tenantId: tenant,
          ticketId: ticketA,
          phash: 0b1010n,
          orderId: "gid://shopify/Order/1",
        });
        // A different ticket about the SAME order re-uploads the same photo —
        // legitimate (one damaged order, a follow-up), not fraud.
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1011n, // distance 1
          orderId: "gid://shopify/Order/1",
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it("DOES flag a near match linked to a DIFFERENT order", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({
          tenantId: tenant,
          ticketId: ticketA,
          phash: 0b1010n,
          orderId: "gid://shopify/Order/1",
        });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1011n, // distance 1
          orderId: "gid://shopify/Order/2", // a different order — the reuse scam
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ticketId).toBe(ticketA);
    expect(hits[0]?.orderId).toBe("gid://shopify/Order/1");
  });

  it("flags a near match when the stored hash has no order bound yet", async () => {
    // Order unknown on the prior ticket → we cannot prove it is the same order,
    // so the fraud guard stays conservative and still flags.
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 0b1010n });
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1011n,
          orderId: "gid://shopify/Order/2",
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(1);
  });

  it("bindOrder stamps the order onto a ticket's un-bound hashes", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 0b1010n });
        // The ticket's order is identified later; bind it onto the recorded row.
        yield* store.bindOrder({
          tenantId: tenant,
          ticketId: ticketA,
          orderId: "gid://shopify/Order/1",
        });
        // Now a same-order lookup from another ticket must be suppressed.
        return yield* store.findSimilar({
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1010n,
          orderId: "gid://shopify/Order/1",
          maxDistance: 5,
          sinceDays: 90,
        });
      }),
    );
    expect(hits).toHaveLength(0);
  });

  it("listPhashesForTicket returns only that ticket's hashes", async () => {
    const phashes = await run(
      Effect.gen(function* () {
        const store = yield* ImageHashStore;
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 5n });
        yield* store.record({ tenantId: tenant, ticketId: ticketA, phash: 6n });
        yield* store.record({ tenantId: tenant, ticketId: ticketB, phash: 7n });
        return yield* store.listPhashesForTicket({
          tenantId: tenant,
          ticketId: ticketA,
        });
      }),
    );
    expect([...phashes].sort()).toEqual([5n, 6n]);
  });
});

describe("matchSimilar", () => {
  it("filters out rows older than the window and sorts nearest-first", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const recent = new Date("2026-05-20T00:00:00.000Z"); // 12 days ago
    const old = new Date("2026-01-01T00:00:00.000Z"); // >90 days ago
    const hits = matchSimilar(
      [
        { tenantId: tenant, ticketId: ticketA, phash: 0b1110n, createdAt: recent },
        { tenantId: tenant, ticketId: ticketB, phash: 0b1010n, createdAt: recent },
        { tenantId: tenant, ticketId: ticketA, phash: 0b1010n, createdAt: old },
      ],
      {
        tenantId: tenant,
        ticketId: TicketId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
        phash: 0b1010n,
        maxDistance: 5,
        sinceDays: 90,
        now,
      },
    );
    // The old row is excluded; ticketB (distance 0) sorts before ticketA (distance 1).
    expect(hits.map((h) => h.ticketId)).toEqual([ticketB, ticketA]);
    expect(hits[0]?.distance).toBe(0);
  });

  it("excludes a row bound to the same order as the lookup", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const recent = new Date("2026-05-20T00:00:00.000Z");
    const hits = matchSimilar(
      [
        {
          tenantId: tenant,
          ticketId: ticketA,
          phash: 0b1010n,
          orderId: "gid://shopify/Order/1",
          createdAt: recent,
        },
        {
          tenantId: tenant,
          ticketId: ticketB,
          phash: 0b1010n,
          orderId: "gid://shopify/Order/2",
          createdAt: recent,
        },
      ],
      {
        tenantId: tenant,
        ticketId: TicketId("cccccccc-cccc-cccc-cccc-cccccccccccc"),
        phash: 0b1010n,
        orderId: "gid://shopify/Order/1",
        maxDistance: 5,
        sinceDays: 90,
        now,
      },
    );
    // Same-order row (ticketA) is suppressed; the different-order row remains.
    expect(hits.map((h) => h.ticketId)).toEqual([ticketB]);
  });
});
