import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TicketId, TenantId } from "@support-agent/agent-core";
import { TimerService } from "@support-agent/services";
import {
  tickets,
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
    const ticketId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "Timer Test" });
    await db.insert(tickets).values({
      id: ticketId,
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
              ticketId: TicketId(ticketId),
              fireAt: new Date("2026-05-26T12:00:00.000Z"),
              reason: "follow_up",
            });
            yield* svc.schedule({
              ticketId: TicketId(ticketId),
              fireAt: new Date("2026-05-26T13:00:00.000Z"),
              reason: "sla",
            });
            const due = yield* svc.listDue(
              new Date("2026-05-26T12:00:00.000Z"),
            );
            // listDue is a pure read (audit L3a) — still due until marked.
            const stillDue = yield* svc.listDue(
              new Date("2026-05-26T12:00:00.000Z"),
            );
            yield* svc.markFired(
              due[0]!.id,
              new Date("2026-05-26T12:00:30.000Z"),
            );
            const afterMark = yield* svc.listDue(
              new Date("2026-05-26T12:01:00.000Z"),
            );
            const cancelled = yield* svc.cancelOpenForTicket(TicketId(ticketId));
            return { followUp, due, stillDue, afterMark, cancelled };
          }),
          layer,
        ),
      );

      expect(out.due.map((t) => t.id)).toEqual([out.followUp.id]);
      expect(out.stillDue.map((t) => t.id)).toEqual([out.followUp.id]);
      expect(out.afterMark).toEqual([]);
      expect(out.cancelled).toBe(1);
    } finally {
      await db.delete(timers).where(eq(timers.ticketId, ticketId));
      await db.delete(tickets).where(eq(tickets.id, ticketId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });
});
