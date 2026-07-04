import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TicketId, TenantId } from "@support-agent/agent-core";
import {
  AuditLogService,
  AuditLogServiceTest,
} from "../src/audit-log.js";

const newRun = <A, E>(eff: Effect.Effect<A, E, AuditLogService>) =>
  Effect.runPromise(Effect.provide(eff, AuditLogServiceTest));

describe("AuditLogService (Test layer)", () => {
  it("records an entry and assigns an id + occurredAt", async () => {
    const entry = await newRun(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        return yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "system", id: "runtime" },
          action: "event.received",
          details: { event: "ticket.created" },
        });
      }),
    );
    expect(entry.id).toBe(1n);
    expect(entry.action).toBe("event.received");
    expect(entry.actor).toEqual({ type: "system", id: "runtime" });
    expect(entry.occurredAt).toBeInstanceOf(Date);
  });

  it("forTicket returns only entries for the requested ticket, in id order", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "system", id: "runtime" },
          action: "event.received",
          details: {},
        });
        yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c2"),
          actor: { type: "agent", id: "support-triage" },
          action: "llm.decision",
          details: {},
        });
        yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "agent", id: "support-triage" },
          action: "tool.invoked",
          details: { tool: "ticket.update_status" },
        });

        return yield* log.forTicket(TicketId("c1"));
      }),
    );
    expect(result.map((e) => e.action)).toEqual([
      "event.received",
      "tool.invoked",
    ]);
  });

  it("forTicket honors afterId for pagination", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        const a = yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "system", id: null },
          action: "a",
          details: {},
        });
        yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "system", id: null },
          action: "b",
          details: {},
        });
        yield* log.record({
          tenantId: TenantId("t1"),
          ticketId: TicketId("c1"),
          actor: { type: "system", id: null },
          action: "c",
          details: {},
        });
        return yield* log.forTicket(TicketId("c1"), { afterId: a.id });
      }),
    );
    expect(result.map((e) => e.action)).toEqual(["b", "c"]);
  });

  it("forTicket honors limit", async () => {
    const result = await newRun(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        for (let i = 0; i < 5; i++) {
          yield* log.record({
            tenantId: TenantId("t1"),
            ticketId: TicketId("c1"),
            actor: { type: "system", id: null },
            action: `a${i}`,
            details: {},
          });
        }
        return yield* log.forTicket(TicketId("c1"), { limit: 2 });
      }),
    );
    expect(result).toHaveLength(2);
  });
});
