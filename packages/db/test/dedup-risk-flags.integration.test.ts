import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { makeDbClient, tenants, tickets } from "../src/index.js";

// Verifies migration 0038_dedup_risk_flags: collapses ANY exact-duplicate entry
// in `tickets.context.riskFlags` (not only rows 0037 touched), keeping each
// flag's first occurrence. The transform below is the exact UPDATE shipped in
// the migration, with a `tenant_id` scope added so the test only touches its own
// seeded rows.
const dedupForTenant = (
  sql: ReturnType<typeof makeDbClient>["sql"],
  tenantId: string,
) => sql`
  UPDATE "tickets" AS t
  SET "context" = jsonb_set(
    t."context",
    '{riskFlags}',
    COALESCE(
      (
        SELECT jsonb_agg(elem ORDER BY ord)
        FROM (
          SELECT elem, MIN(ord) AS ord
          FROM jsonb_array_elements_text(t."context"->'riskFlags')
            WITH ORDINALITY AS a(elem, ord)
          GROUP BY elem
        ) deduped
      ),
      '[]'::jsonb
    )
  )
  WHERE t."tenant_id" = ${tenantId}
    AND jsonb_typeof(t."context"->'riskFlags') = 'array'
    AND jsonb_array_length(t."context"->'riskFlags') > (
      SELECT count(DISTINCT elem)
      FROM jsonb_array_elements_text(t."context"->'riskFlags') AS g(elem)
    );
`;

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("0038 dedup risk flags (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db, sql } = client;
  const tenantId = randomUUID();

  const ids = {
    dupTicketFlag: randomUUID(),
    dupMixed: randomUUID(),
    noDup: randomUUID(),
    empty: randomUUID(),
    noRiskFlags: randomUUID(),
  };

  const seed = (id: string, context: Record<string, unknown>) =>
    db.insert(tickets).values({
      id,
      tenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
      context,
    });

  const flagsOf = async (id: string): Promise<unknown> => {
    const rows = await sql<{ flags: unknown }[]>`
      SELECT "context"->'riskFlags' AS flags FROM "tickets" WHERE id = ${id}
    `;
    return rows[0]?.flags;
  };

  beforeAll(async () => {
    await db.insert(tenants).values({ id: tenantId, name: "Dedup Test" });
    // Pure `_ticket_` duplicate with no legacy flag — the case 0037 could not fix.
    await seed(ids.dupTicketFlag, {
      riskFlags: [
        "duplicate_photo_seen_in_ticket_X",
        "duplicate_photo_seen_in_ticket_X",
        "duplicate_photo_seen_in_ticket_Y",
      ],
    });
    // Duplicate non-photo flag interleaved — order of first occurrence kept.
    await seed(ids.dupMixed, {
      riskFlags: [
        "refund_customer_mismatch",
        "duplicate_photo_seen_in_ticket_Z",
        "refund_customer_mismatch",
      ],
    });
    await seed(ids.noDup, {
      riskFlags: ["duplicate_photo_seen_in_ticket_A", "high_value"],
    });
    await seed(ids.empty, { riskFlags: [] });
    await seed(ids.noRiskFlags, { classification: "returns" });

    await dedupForTenant(sql, tenantId);
  });

  afterAll(async () => {
    await db.delete(tickets).where(eq(tickets.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await client.close();
  });

  it("collapses a repeated ticket flag, keeping order", async () => {
    expect(await flagsOf(ids.dupTicketFlag)).toEqual([
      "duplicate_photo_seen_in_ticket_X",
      "duplicate_photo_seen_in_ticket_Y",
    ]);
  });

  it("collapses a repeated non-photo flag, keeping first-occurrence order", async () => {
    expect(await flagsOf(ids.dupMixed)).toEqual([
      "refund_customer_mismatch",
      "duplicate_photo_seen_in_ticket_Z",
    ]);
  });

  it("leaves an already-distinct array untouched", async () => {
    expect(await flagsOf(ids.noDup)).toEqual([
      "duplicate_photo_seen_in_ticket_A",
      "high_value",
    ]);
  });

  it("leaves an empty array as an empty array", async () => {
    expect(await flagsOf(ids.empty)).toEqual([]);
  });

  it("does not add a riskFlags key to tickets that have none", async () => {
    expect(await flagsOf(ids.noRiskFlags)).toBeNull();
  });
});
