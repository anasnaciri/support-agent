import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CaseId, TenantId } from "@support-agent/agent-core";
import { AuditLogService } from "@support-agent/services";
import {
  AuditLogServiceLive,
  DbClient,
  DbClientLive,
  auditLog,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("AuditLogService (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const caseId = randomUUID();

  const liveLayer = Layer.provide(
    AuditLogServiceLive,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const runLive = <A, E>(
    eff: Effect.Effect<A, E, AuditLogService | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "audit-test" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("record persists an entry that can be read via forCase", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        const a = yield* log.record({
          tenantId: TenantId(tenantId),
          caseId: CaseId(caseId),
          actor: { type: "system", id: "runtime" },
          action: "event.received",
          details: { event: "ticket.created" },
        });
        const b = yield* log.record({
          tenantId: TenantId(tenantId),
          caseId: CaseId(caseId),
          actor: { type: "agent", id: "support-triage" },
          action: "llm.decision",
          details: { turn: 0 },
        });
        const list = yield* log.forCase(CaseId(caseId));
        return { a, b, list };
      }),
    );
    expect(result.list.length).toBeGreaterThanOrEqual(2);
    expect(result.list[0]?.action).toBe("event.received");
    expect(result.list[1]?.action).toBe("llm.decision");
    expect(typeof result.a.id).toBe("bigint");
    expect(result.b.id).toBeGreaterThan(result.a.id);
  });

  it("forCase pagination via afterId returns only newer rows", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        const all = yield* log.forCase(CaseId(caseId));
        const cursor = all[0]!.id;
        const rest = yield* log.forCase(CaseId(caseId), { afterId: cursor });
        return { cursor, rest };
      }),
    );
    for (const entry of result.rest) {
      expect(entry.id).toBeGreaterThan(result.cursor);
    }
  });
});
