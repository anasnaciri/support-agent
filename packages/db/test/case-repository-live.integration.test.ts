import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  AgentId,
  TenantId,
  ThreadId,
} from "@support-agent/agent-core";
import {
  CaseRepository,
  CaseStateConflict,
} from "@support-agent/services";
import {
  CaseRepositoryLive,
  DbClient,
  DbClientLive,
  caseStateTransitions,
  cases,
  tenants,
  makeDbClient,
} from "../src/index.js";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("CaseRepository (Live, integration)", () => {
  // direct client for raw cleanup
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();

  const liveLayer = Layer.provide(
    CaseRepositoryLive,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const runLive = <A, E>(
    eff: Effect.Effect<A, E, CaseRepository | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runLiveExit = <A, E>(
    eff: Effect.Effect<A, E, CaseRepository | DbClient>,
  ) =>
    Effect.runPromiseExit(
      Effect.provide(eff, liveLayer).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "live-test" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db.delete(cases).where(sql`${cases.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("creates and reads a case", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const created = yield* repo.create({
          tenantId: TenantId(tenantId),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId(`thread-${randomUUID()}`),
          subject: "Where is my order?",
        });
        const fetched = yield* repo.getById(created.id);
        return { created, fetched };
      }),
    );
    expect(result.fetched.id).toBe(result.created.id);
    expect(result.fetched.subject).toBe("Where is my order?");
    expect(result.fetched.status).toBe("new");
  });

  it("transitionStatus writes case_state_transitions in the same tx", async () => {
    const threadId = `thread-${randomUUID()}`;
    const result = await runLive(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const c = yield* repo.create({
          tenantId: TenantId(tenantId),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId(threadId),
        });
        const transitioned = yield* repo.transitionStatus(c.id, "resolved", {
          expectedFromStatus: "new",
          reason: "integration-test",
        });
        return { caseId: c.id, transitioned };
      }),
    );
    expect(result.transitioned.status).toBe("resolved");
    expect(result.transitioned.resolvedAt).not.toBeNull();

    const transitionRows = await raw!.db
      .select()
      .from(caseStateTransitions)
      .where(sql`${caseStateTransitions.caseId} = ${result.caseId}`);
    expect(transitionRows.length).toBe(1);
    expect(transitionRows[0]?.fromStatus).toBe("new");
    expect(transitionRows[0]?.toStatus).toBe("resolved");
    expect(transitionRows[0]?.reason).toBe("integration-test");
  });

  it("transitionStatus rejects with CaseStateConflict when expected status mismatches", async () => {
    const exit = await runLiveExit(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        const c = yield* repo.create({
          tenantId: TenantId(tenantId),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId(`thread-${randomUUID()}`),
          status: "in_progress",
        });
        return yield* repo.transitionStatus(c.id, "resolved", {
          expectedFromStatus: "new",
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(CaseStateConflict);
    }
  });
});
