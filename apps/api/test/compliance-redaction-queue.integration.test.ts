import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { DbClientLive, makeDbClient } from "@support-agent/db";
import { redactTenantQueueJobs } from "../src/compliance-redaction.js";

// Audit D7: tenant PII (full email bodies in `message.received` payloads)
// survives in pgboss.job / the pg-boss archive after a tenant wipe. The
// queue-redaction helper must delete rows whose `data->'event'->>'tenantId'`
// matches — and tolerate the pgboss schema not existing (dev). Exercised
// against a throwaway schema so the test owns its data end to end.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("redactTenantQueueJobs (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const schema = `pgboss_test_${randomUUID().slice(0, 8)}`;
  const tenantX = randomUUID();
  const tenantY = randomUUID();

  const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(eff, DbClientLive({ databaseUrl: databaseUrl! })),
      ) as Effect.Effect<A, E, never>,
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await raw.sql.unsafe(
      `CREATE TABLE "${schema}".job (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, data jsonb)`,
    );
    await raw.sql.unsafe(
      `CREATE TABLE "${schema}".archive (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, data jsonb)`,
    );
    const event = (tenantId: string) => ({
      eventId: randomUUID(),
      event: {
        type: "message.received",
        tenantId,
        threadId: "gmail:t1",
        payload: { bodyText: "full customer email body (PII)" },
      },
      key: `thread:${tenantId}:t1`,
      enqueuedAt: new Date().toISOString(),
    });
    await raw.sql.unsafe(
      `INSERT INTO "${schema}".job (name, data) VALUES
        ('workflow.events', '${JSON.stringify(event(tenantX))}'::jsonb),
        ('workflow.events', '${JSON.stringify(event(tenantY))}'::jsonb),
        ('account.cleanup', '${JSON.stringify({ tenantId: tenantX, tenantName: "X" })}'::jsonb)`,
    );
    await raw.sql.unsafe(
      `INSERT INTO "${schema}".archive (name, data) VALUES
        ('workflow.events', '${JSON.stringify(event(tenantX))}'::jsonb)`,
    );
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await raw.close();
  });

  it("deletes only the tenant's event-carrying rows from job + archive", async () => {
    const result = await run(redactTenantQueueJobs(tenantX, schema));
    expect(result.deletedJobRows).toBe(1);
    expect(result.deletedArchiveRows).toBe(1);

    const left = await raw!.sql.unsafe(
      `SELECT name, data FROM "${schema}".job ORDER BY name`,
    );
    // The account.cleanup job (tenantId at top level, no nested event) must
    // SURVIVE — it is what finishes the deletion — and the other tenant's
    // event is untouched.
    expect(left.map((r: { name: string }) => r.name)).toEqual([
      "account.cleanup",
      "workflow.events",
    ]);
    const archiveLeft = await raw!.sql.unsafe(
      `SELECT 1 FROM "${schema}".archive`,
    );
    expect(archiveLeft.length).toBe(0);
  });

  it("tolerates a missing pgboss schema (dev) without failing", async () => {
    const result = await run(
      redactTenantQueueJobs(tenantX, "pgboss_does_not_exist"),
    );
    expect(result.deletedJobRows).toBe(0);
    expect(result.deletedArchiveRows).toBe(0);
  });

  it("rejects an unsafe schema name instead of interpolating it", async () => {
    await expect(
      run(redactTenantQueueJobs(tenantX, 'pg"; DROP TABLE x; --')),
    ).rejects.toThrow();
  });
});
