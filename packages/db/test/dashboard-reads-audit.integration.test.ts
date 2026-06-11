// Audit D11: todaySummary's "resolved today" must use a UTC day boundary,
// not server-local midnight. Pin a non-UTC, DST-free zone so the test means
// the same thing on every machine (Node honors runtime TZ changes).
process.env["TZ"] = "Pacific/Honolulu"; // UTC-10, no DST

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  cases as casesTable,
  makeDbClient,
  tenants,
  todaySummary,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("todaySummary day boundary (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;
  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      await db
        .delete(casesTable)
        .where(inArray(casesTable.tenantId, seededTenants));
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  it("counts resolved-today from UTC midnight, not server-local midnight", async () => {
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Today UTC Test" });
    seededTenants.push(tenantId);

    // "now" = 05:00Z. UTC midnight = 2026-06-10T00:00Z; Honolulu-local
    // midnight of the same instant = 2026-06-09T10:00Z.
    const now = new Date("2026-06-10T05:00:00Z");
    const resolvedCase = (resolvedAt: Date) => ({
      id: randomUUID(),
      tenantId,
      channel: "email" as const,
      status: "resolved" as const,
      currentAgentId: "support-triage",
      resolvedAt,
    });
    await db.insert(casesTable).values([
      // Yesterday in UTC terms (23:00Z on the 9th) — must NOT count, even
      // though it is after Honolulu-local midnight.
      resolvedCase(new Date("2026-06-09T23:00:00Z")),
      // Today in UTC terms — must count.
      resolvedCase(new Date("2026-06-10T01:00:00Z")),
    ]);

    const summary = await todaySummary(db, tenantId, now);
    expect(summary.resolvedTodayCount).toBe(1);
  });
});
