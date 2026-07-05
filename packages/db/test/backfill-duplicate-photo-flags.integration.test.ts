import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { makeDbClient, tenants, tickets } from "../src/index.js";

// Verifies migration 0037_backfill_duplicate_photo_flags: rewrites the
// pre-`case→ticket`-rename `duplicate_photo_seen_in_case_<id>` risk flags still
// persisted in `tickets.context.riskFlags` to the current
// `duplicate_photo_seen_in_ticket_<id>` form. The transform below is the exact
// UPDATE shipped in the migration, with a `tenant_id` scope added so the test
// only touches its own seeded rows (the migration runs it store-wide).
const backfillForTenant = (
  sql: ReturnType<typeof makeDbClient>["sql"],
  tenantId: string,
) => sql`
  UPDATE "tickets" AS t
  SET "context" = jsonb_set(
    t."context",
    '{riskFlags}',
    COALESCE(
      (
        SELECT jsonb_agg(flag ORDER BY ord)
        FROM (
          SELECT flag, MIN(ord) AS ord
          FROM (
            SELECT
              CASE
                WHEN elem LIKE 'duplicate_photo_seen_in_case_%'
                  THEN regexp_replace(
                         elem,
                         '^duplicate_photo_seen_in_case_',
                         'duplicate_photo_seen_in_ticket_'
                       )
                ELSE elem
              END AS flag,
              ord
            FROM jsonb_array_elements_text(t."context"->'riskFlags')
              WITH ORDINALITY AS a(elem, ord)
          ) renamed
          GROUP BY flag
        ) deduped
      ),
      '[]'::jsonb
    )
  )
  WHERE t."tenant_id" = ${tenantId}
    AND jsonb_typeof(t."context"->'riskFlags') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(t."context"->'riskFlags') AS f(elem)
      WHERE f.elem LIKE 'duplicate_photo_seen_in_case_%'
    );
`;

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("0037 backfill duplicate-photo flags (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db, sql } = client;
  const tenantId = randomUUID();

  // id → seeded riskFlags (a `null` context.riskFlags means "no key at all")
  const ids = {
    mixed: randomUUID(),
    alreadyTicket: randomUUID(),
    otherFlags: randomUUID(),
    noRiskFlags: randomUUID(),
    empty: randomUUID(),
    sameTicketBothVocab: randomUUID(),
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
    await db.insert(tenants).values({ id: tenantId, name: "Backfill Test" });
    await seed(ids.mixed, {
      classification: "returns",
      riskFlags: [
        "duplicate_photo_seen_in_case_AAA",
        "refund_customer_mismatch",
        "duplicate_photo_seen_in_case_BBB",
      ],
    });
    await seed(ids.alreadyTicket, {
      riskFlags: ["duplicate_photo_seen_in_ticket_CCC"],
    });
    await seed(ids.otherFlags, { riskFlags: ["high_value"] });
    await seed(ids.noRiskFlags, { classification: "returns" });
    await seed(ids.empty, { riskFlags: [] });
    // Same prior ticket flagged under both vocabularies over time — after the
    // rename both become `..._in_ticket_DDD`, so the pass must collapse them to
    // one, keeping the first occurrence's position.
    await seed(ids.sameTicketBothVocab, {
      riskFlags: [
        "duplicate_photo_seen_in_case_DDD",
        "refund_customer_mismatch",
        "duplicate_photo_seen_in_ticket_DDD",
      ],
    });

    await backfillForTenant(sql, tenantId);
  });

  afterAll(async () => {
    await db.delete(tickets).where(eq(tickets.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await client.close();
  });

  it("rewrites `..._in_case_` flags to `..._in_ticket_`, preserving id, order, and other flags", async () => {
    expect(await flagsOf(ids.mixed)).toEqual([
      "duplicate_photo_seen_in_ticket_AAA",
      "refund_customer_mismatch",
      "duplicate_photo_seen_in_ticket_BBB",
    ]);
  });

  it("leaves already-current `..._in_ticket_` flags untouched", async () => {
    expect(await flagsOf(ids.alreadyTicket)).toEqual([
      "duplicate_photo_seen_in_ticket_CCC",
    ]);
  });

  it("leaves unrelated risk flags untouched", async () => {
    expect(await flagsOf(ids.otherFlags)).toEqual(["high_value"]);
  });

  it("does not add a riskFlags key to tickets that have none", async () => {
    expect(await flagsOf(ids.noRiskFlags)).toBeNull();
  });

  it("leaves an empty riskFlags array as an empty array", async () => {
    expect(await flagsOf(ids.empty)).toEqual([]);
  });

  it("collapses a duplicate the rename creates for the same ticket, preserving order", async () => {
    expect(await flagsOf(ids.sameTicketBothVocab)).toEqual([
      "duplicate_photo_seen_in_ticket_DDD",
      "refund_customer_mismatch",
    ]);
  });
});
