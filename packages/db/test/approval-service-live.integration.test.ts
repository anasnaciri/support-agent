import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  AgentId,
  CaseId,
  TenantId,
  UserId,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  ApprovalStateConflict,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  DbClient,
  DbClientLive,
  approvals,
  cases,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ApprovalService (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const caseId = randomUUID();

  const liveLayer = Layer.provide(
    ApprovalServiceLive,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const runLive = <A, E>(
    eff: Effect.Effect<A, E, ApprovalService | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runLiveExit = <A, E>(
    eff: Effect.Effect<A, E, ApprovalService | DbClient>,
  ) =>
    Effect.runPromiseExit(
      Effect.provide(eff, liveLayer).pipe(Effect.scoped),
    );

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: "appr-test" });
    await raw.db.insert(cases).values({
      id: caseId,
      tenantId,
      channel: "email",
      status: "new",
      currentAgentId: "support-triage",
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(approvals)
      .where(sql`${approvals.tenantId} = ${tenantId}`);
    await raw.db.delete(cases).where(sql`${cases.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  const sample = () => ({
    tenantId: TenantId(tenantId),
    caseId: CaseId(caseId),
    agentId: AgentId("support-triage"),
    tool: "refund.create",
    proposedInput: { amountCents: 2000 },
    reasoning: "test",
    riskLevel: "high" as const,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  it("create + approve round-trip writes the full decision", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sample());
        const approved = yield* svc.approve({
          id: created.id,
          decidedBy: UserId(randomUUID()),
          decisionReason: "ok",
          approvedInput: { amountCents: 1500 },
        });
        const fetched = yield* svc.getById(created.id);
        return { created, approved, fetched };
      }),
    );
    expect(result.approved.status).toBe("approved");
    expect(result.approved.approvedInput).toEqual({ amountCents: 1500 });
    expect(result.fetched.status).toBe("approved");
    expect(result.fetched.decisionReason).toBe("ok");
  });

  it("re-approving a resolved approval returns ApprovalStateConflict", async () => {
    const exit = await runLiveExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sample());
        yield* svc.approve({
          id: created.id,
          decidedBy: UserId(randomUUID()),
        });
        return yield* svc.approve({
          id: created.id,
          decidedBy: UserId(randomUUID()),
        });
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ApprovalStateConflict);
    }
  });

  it("listPending excludes decided rows", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const a = yield* svc.create(sample());
        yield* svc.create(sample());
        yield* svc.reject({
          id: a.id,
          decidedBy: UserId(randomUUID()),
          decisionReason: "test reject",
        });
        return yield* svc.listPending(TenantId(tenantId));
      }),
    );
    for (const a of result) {
      expect(a.status).toBe("pending");
      expect(a.tenantId).toBe(tenantId);
    }
  });
});
