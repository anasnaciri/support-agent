import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TicketId, TenantId } from "@support-agent/agent-core";
import { ImageHashStore } from "@support-agent/services";
import {
  tickets,
  DbClientLive,
  imageHashes,
  ImageHashStoreLive,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ImageHashStoreLive", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  const layer = ImageHashStoreLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  it("records hashes and finds near-matches across tickets (signed 64-bit round-trip)", async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const ticketA = randomUUID();
    const ticketB = randomUUID();
    await db.insert(tenants).values([
      { id: tenantId, name: "Hash Test" },
      { id: otherTenantId, name: "Hash Test Other" },
    ]);
    await db.insert(tickets).values([
      {
        id: ticketA,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "damaged-product-agent",
      },
      {
        id: ticketB,
        tenantId,
        channel: "email",
        status: "new",
        currentAgentId: "damaged-product-agent",
      },
    ]);

    // A hash with the top (sign) bit set exercises the signed-bigint
    // round-trip through the Postgres bigint column.
    const phashA = BigInt.asIntN(64, 0xf000_0000_0000_0001n);

    try {
      const hits = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ImageHashStore;
            yield* store.record({
              tenantId: TenantId(tenantId),
              ticketId: TicketId(ticketA),
              phash: phashA,
            });
            // Same tenant, different ticket, distance 1 (one extra low bit).
            return yield* store.findSimilar({
              tenantId: TenantId(tenantId),
              ticketId: TicketId(ticketB),
              phash: BigInt.asIntN(64, 0xf000_0000_0000_0003n),
              maxDistance: 5,
              sinceDays: 90,
            });
          }),
          layer,
        ),
      );

      expect(hits).toHaveLength(1);
      expect(hits[0]?.ticketId).toBe(ticketA);
      expect(hits[0]?.distance).toBe(1);
      expect(hits[0]?.phash).toBe(phashA);
    } finally {
      await db.delete(imageHashes).where(eq(imageHashes.tenantId, tenantId));
      await db.delete(tickets).where(eq(tickets.tenantId, tenantId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
      await db.delete(tenants).where(eq(tenants.id, otherTenantId));
    }
  });
});
