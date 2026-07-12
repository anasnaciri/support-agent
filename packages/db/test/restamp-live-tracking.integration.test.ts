import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";

import {
  makeDbClient,
  restampTicketLiveTracking,
  tenants,
  tickets,
} from "../src/index.js";

// The Tracking card's live endpoint follows the order's Shopify fulfillment
// number; when the on-ticket `liveTrackingStatus` stamp still describes a
// DIFFERENT (superseded) number, the endpoint self-heals the saved stamp with
// the fresh lookup it just fetched. The guard lives in SQL so a concurrent
// runtime stamp is never clobbered and a page view never invents a stamp on a
// ticket that has none.

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("restampTicketLiveTracking (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db, sql } = client;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const ids = {
    stale: randomUUID(),
    same: randomUUID(),
    noStamp: randomUUID(),
    foreign: randomUUID(),
  };

  const staleStamp = {
    kind: "live",
    trackingNumber: "OLD123",
    carrier: "191997",
    status: "exception",
  };

  const freshTracking = {
    kind: "live",
    trackingNumber: "NEW456",
    carrier: "USPS",
    status: "in_transit",
    lastScan: null,
    estimatedDeliveryAt: null,
    trackingUrl: null,
    originCountry: null,
    destinationCountry: "US",
    transitDays: 2,
    checkpoints: [],
    reason: null,
  };

  const seed = (id: string, owner: string, context: Record<string, unknown>) =>
    db.insert(tickets).values({
      id,
      tenantId: owner,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
      context,
    });

  const contextOf = async (id: string): Promise<Record<string, unknown>> => {
    const rows = await sql<{ context: Record<string, unknown> }[]>`
      SELECT "context" FROM "tickets" WHERE id = ${id}
    `;
    return rows[0]!.context;
  };

  beforeAll(async () => {
    await db.insert(tenants).values([
      { id: tenantId, name: "restamp-test" },
      { id: otherTenantId, name: "restamp-other" },
    ]);
    await seed(ids.stale, tenantId, {
      scenarioKey: "delivery_issue",
      liveTrackingStatus: staleStamp,
    });
    await seed(ids.same, tenantId, {
      liveTrackingStatus: { ...staleStamp, trackingNumber: "NEW456" },
    });
    await seed(ids.noStamp, tenantId, { scenarioKey: "delivery_issue" });
    await seed(ids.foreign, otherTenantId, {
      liveTrackingStatus: staleStamp,
    });
  });

  afterAll(async () => {
    await db.delete(tickets).where(inArray(tickets.id, Object.values(ids)));
    await db
      .delete(tenants)
      .where(inArray(tenants.id, [tenantId, otherTenantId]));
    await client.close();
  });

  it("replaces a stamp describing a superseded number, keeping the rest of the context", async () => {
    const restamped = await restampTicketLiveTracking(db, {
      tenantId,
      ticketId: ids.stale,
      tracking: freshTracking,
    });
    expect(restamped).toBe(true);
    const ctx = await contextOf(ids.stale);
    expect(ctx["liveTrackingStatus"]).toEqual(freshTracking);
    expect(ctx["scenarioKey"]).toBe("delivery_issue");
  });

  it("leaves a stamp that already carries the same number untouched", async () => {
    const restamped = await restampTicketLiveTracking(db, {
      tenantId,
      ticketId: ids.same,
      tracking: freshTracking,
    });
    expect(restamped).toBe(false);
    const ctx = await contextOf(ids.same);
    // Not overwritten — the original (older) stamp object is still there.
    expect(ctx["liveTrackingStatus"]).toEqual({
      ...staleStamp,
      trackingNumber: "NEW456",
    });
  });

  it("never invents a stamp on a ticket that has none", async () => {
    const restamped = await restampTicketLiveTracking(db, {
      tenantId,
      ticketId: ids.noStamp,
      tracking: freshTracking,
    });
    expect(restamped).toBe(false);
    const ctx = await contextOf(ids.noStamp);
    expect(ctx["liveTrackingStatus"]).toBeUndefined();
  });

  it("is tenant-scoped: a foreign ticket is never touched", async () => {
    const restamped = await restampTicketLiveTracking(db, {
      tenantId,
      ticketId: ids.foreign,
      tracking: freshTracking,
    });
    expect(restamped).toBe(false);
    const ctx = await contextOf(ids.foreign);
    expect(ctx["liveTrackingStatus"]).toEqual(staleStamp);
  });
});
