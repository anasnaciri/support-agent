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
  CaseRepository,
} from "@support-agent/services";
import {
  AuditLogServiceLive,
  CaseRepositoryLive,
  DbClient,
  DbClientLive,
  auditLog,
  cases,
  makeDbClient,
  tenants,
  withTransaction,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("withTransaction — audit + case writes share one tx", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();

  const services = Layer.mergeAll(CaseRepositoryLive, AuditLogServiceLive);
  // `provideMerge` (not `provide`) so the outer layer still exposes DbClient
  // — `withTransaction` requires it.
  const liveLayer = Layer.provideMerge(
    services,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const run = <A, E>(
    eff: Effect.Effect<A, E, CaseRepository | AuditLogService | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runExit = <A, E>(
    eff: Effect.Effect<A, E, CaseRepository | AuditLogService | DbClient>,
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
    await raw.db.delete(cases).where(sql`${cases.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("commits both case and audit-log writes when the inner Effect succeeds", async () => {
    const result = await run(
      Effect.gen(function* () {
        return yield* withTransaction(
          Effect.gen(function* () {
            const repo = yield* CaseRepository;
            const log = yield* AuditLogService;
            const created = yield* repo.create({
              tenantId: TenantId(tenantId),
              channel: "email",
              currentAgentId: AgentId("support-triage"),
            });
            yield* log.record({
              tenantId: TenantId(tenantId),
              caseId: created.id,
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
    const caseRows = await raw!.db
      .select({ id: cases.id })
      .from(cases)
      .where(sql`${cases.id} = ${result}`);
    expect(caseRows).toHaveLength(1);

    const auditRows = await raw!.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.caseId} = ${result}`);
    expect(auditRows).toHaveLength(1);
  });

  it("rolls BOTH writes back when the inner Effect fails", async () => {
    let createdCaseId: string | null = null;

    const exit = await runExit(
      withTransaction(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
          const log = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId(tenantId),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
          });
          createdCaseId = created.id;

          yield* log.record({
            tenantId: TenantId(tenantId),
            caseId: created.id,
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
    expect(createdCaseId).not.toBeNull();

    // Postgres must have no row for the case, no row for the audit entry.
    const caseRows = await raw!.db
      .select({ id: cases.id })
      .from(cases)
      .where(sql`${cases.id} = ${createdCaseId!}`);
    expect(caseRows).toHaveLength(0);

    const auditRows = await raw!.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.caseId} = ${createdCaseId!}`);
    expect(auditRows).toHaveLength(0);
  });

  it("propagates the original tagged error after rollback", async () => {
    class RecognizableError {
      readonly _tag = "RecognizableError";
    }

    const exit = await runExit(
      withTransaction(
        Effect.gen(function* () {
          const repo = yield* CaseRepository;
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
