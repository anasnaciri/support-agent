import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CaseId, TenantId } from "@support-agent/agent-core";
import { TimerService } from "@support-agent/services";
import {
  cases,
  DbClientLive,
  makeDbClient,
  tenants,
  timers,
  TimerServiceLive,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("TimerServiceLive", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  afterAll(async () => {
    await client.close();
  });

  const layer = TimerServiceLive.pipe(
    Layer.provide(DbClientLive({ databaseUrl: databaseUrl! })),
  );

  it("schedules, fires, and cancels timers", async () => {
    const tenantId = randomUUID();
    const caseId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Timer Test" });
    await db.insert(cases).values({
      id: caseId,
      tenantId,
      channel: "email",
      status: "waiting_for_customer",
      currentAgentId: "support-triage",
    });

    try {
      const out = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const svc = yield* TimerService;
            const followUp = yield* svc.schedule({
              caseId: CaseId(caseId),
              fireAt: new Date("2026-05-26T12:00:00.000Z"),
              reason: "follow_up",
            });
            yield* svc.schedule({
              caseId: CaseId(caseId),
              fireAt: new Date("2026-05-26T13:00:00.000Z"),
              reason: "sla",
            });
            const fired = yield* svc.fireDue(
              new Date("2026-05-26T12:00:00.000Z"),
            );
            const cancelled = yield* svc.cancelOpenForCase(CaseId(caseId));
            return { followUp, fired, cancelled };
          }),
          layer,
        ),
      );

      expect(out.fired.map((t) => t.id)).toEqual([out.followUp.id]);
      expect(out.fired[0]?.firedAt).toEqual(
        new Date("2026-05-26T12:00:00.000Z"),
      );
      expect(out.cancelled).toBe(1);
    } finally {
      await db.delete(timers).where(eq(timers.caseId, caseId));
      await db.delete(cases).where(eq(cases.id, caseId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });
});
