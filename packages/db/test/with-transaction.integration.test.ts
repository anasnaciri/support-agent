import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  AgentId,
  TenantId,
} from "@support-agent/agent-core";
import {
  AuditLogService,
  TicketRepository,
} from "@support-agent/services";
import {
  AuditLogServiceLive,
  TicketRepositoryLive,
  DbClient,
  DbClientLive,
  auditLog,
  tickets,
  makeDbClient,
  tenants,
  withTransaction,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("withTransaction — audit + ticket writes share one tx", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();

  const services = Layer.mergeAll(TicketRepositoryLive, AuditLogServiceLive);
  // `provideMerge` (not `provide`) so the outer layer still exposes DbClient
  // — `withTransaction` requires it.
  const liveLayer = Layer.provideMerge(
    services,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const run = <A, E>(
    eff: Effect.Effect<A, E, TicketRepository | AuditLogService | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runExit = <A, E>(
    eff: Effect.Effect<A, E, TicketRepository | AuditLogService | DbClient>,
  ) =>
    Effect.runPromiseExit(
      Effect.provide(eff, liveLayer).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "tx-test" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantId}`);
    await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("commits both ticket and audit-log writes when the inner Effect succeeds", async () => {
    const result = await run(
      Effect.gen(function* () {
        return yield* withTransaction(
          Effect.gen(function* () {
            const repo = yield* TicketRepository;
            const log = yield* AuditLogService;
            const created = yield* repo.create({
              tenantId: TenantId(tenantId),
              channel: "email",
              currentAgentId: AgentId("support-triage"),
            });
            yield* log.record({
              tenantId: TenantId(tenantId),
              ticketId: created.id,
              actor: { type: "system", id: "runtime" },
              action: "event.received",
              details: { ok: true },
            });
            return created.id;
          }),
        );
      }),
    );

    // Both rows present.
    const ticketRows = await raw!.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(sql`${tickets.id} = ${result}`);
    expect(ticketRows).toHaveLength(1);

    const auditRows = await raw!.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.ticketId} = ${result}`);
    expect(auditRows).toHaveLength(1);
  });

  it("rolls BOTH writes back when the inner Effect fails", async () => {
    let createdTicketId: string | null = null;

    const exit = await runExit(
      withTransaction(
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          const log = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId(tenantId),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
          });
          createdTicketId = created.id;

          yield* log.record({
            tenantId: TenantId(tenantId),
            ticketId: created.id,
            actor: { type: "system", id: "runtime" },
            action: "event.received",
            details: {},
          });

          // Fail AFTER both writes — should roll the whole tx back.
          return yield* Effect.fail(
            new Error("simulated downstream failure"),
          );
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(createdTicketId).not.toBeNull();

    // Postgres must have no row for the ticket, no row for the audit entry.
    const ticketRows = await raw!.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(sql`${tickets.id} = ${createdTicketId!}`);
    expect(ticketRows).toHaveLength(0);

    const auditRows = await raw!.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.ticketId} = ${createdTicketId!}`);
    expect(auditRows).toHaveLength(0);
  });

  it("propagates the original tagged error after rollback", async () => {
    class RecognizableError {
      readonly _tag = "RecognizableError";
    }

    const exit = await runExit(
      withTransaction(
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          yield* repo.create({
            tenantId: TenantId(tenantId),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
          });
          return yield* Effect.fail(new RecognizableError());
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect((exit.cause.error as RecognizableError)._tag).toBe(
        "RecognizableError",
      );
    }
  });
});
