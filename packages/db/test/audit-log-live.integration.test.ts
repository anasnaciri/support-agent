import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TicketId, TenantId } from "@support-agent/agent-core";
import { AuditLogService } from "@support-agent/services";
import {
  AuditLogServiceLive,
  AuditLogServiceLiveRedacted,
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
  const ticketId = randomUUID();

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

  it("record persists an entry that can be read via forTicket", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        const a = yield* log.record({
          tenantId: TenantId(tenantId),
          ticketId: TicketId(ticketId),
          actor: { type: "system", id: "runtime" },
          action: "event.received",
          details: { event: "ticket.created" },
        });
        const b = yield* log.record({
          tenantId: TenantId(tenantId),
          ticketId: TicketId(ticketId),
          actor: { type: "agent", id: "support-triage" },
          action: "llm.decision",
          details: { turn: 0 },
        });
        const list = yield* log.forTicket(TicketId(ticketId));
        return { a, b, list };
      }),
    );
    expect(result.list.length).toBeGreaterThanOrEqual(2);
    expect(result.list[0]?.action).toBe("event.received");
    expect(result.list[1]?.action).toBe("llm.decision");
    expect(typeof result.a.id).toBe("bigint");
    expect(result.b.id).toBeGreaterThan(result.a.id);
  });

  it("forTicket pagination via afterId returns only newer rows", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const log = yield* AuditLogService;
        const all = yield* log.forTicket(TicketId(ticketId));
        const cursor = all[0]!.id;
        const rest = yield* log.forTicket(TicketId(ticketId), { afterId: cursor });
        return { cursor, rest };
      }),
    );
    for (const entry of result.rest) {
      expect(entry.id).toBeGreaterThan(result.cursor);
    }
  });

  it("AuditLogServiceLiveRedacted scrubs PII fields on insert", async () => {
    const redactedTicketId = randomUUID();
    const redactedLayer = Layer.provide(
      AuditLogServiceLiveRedacted,
      DbClientLive({ databaseUrl: databaseUrl! }),
    );
    const inserted = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const log = yield* AuditLogService;
          return yield* log.record({
            tenantId: TenantId(tenantId),
            ticketId: TicketId(redactedTicketId),
            actor: { type: "agent", id: "refund-review-agent" },
            action: "ticket.resolved",
            details: {
              tool: "conversation.reply",
              ok: true,
              finalMessage: "Hi Alice, refund issued to alice@example.com",
              from: { email: "buyer@example.com", phone: "+1 415 555 0100" },
              notes: "Customer +14155550100 follow-up",
            },
          });
        }),
        redactedLayer,
      ).pipe(Effect.scoped),
    );
    const details = inserted.details as {
      readonly tool: string;
      readonly ok: boolean;
      readonly finalMessage: string;
      readonly from: { readonly email: string; readonly phone: string };
      readonly notes: string;
    };
    // Structural fields preserved.
    expect(details.tool).toBe("conversation.reply");
    expect(details.ok).toBe(true);
    // PII-key strings replaced with [redacted].
    expect(details.finalMessage).toBe("[redacted]");
    expect(details.from.email).toBe("[redacted]");
    expect(details.from.phone).toBe("[redacted]");
    // Free-text strings have email + phone patterns scrubbed.
    expect(details.notes).not.toContain("4155550100");
    expect(details.notes).toContain("[redacted]");
  });
});
