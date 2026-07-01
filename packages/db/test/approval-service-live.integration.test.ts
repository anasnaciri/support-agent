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

  // Regression (prod, 2026-06-27): listDecidedUnresumed interpolated a raw
  // JS Date into a drizzle `sql` fragment (`sql`${decidedAt} < ${date}``),
  // which the postgres driver rejects with
  // `TypeError: ... Received an instance of Date`. The error was masked and
  // the L3b republish sweep silently never ran. Only a real-DB seam catches
  // it — the in-memory Test layer doesn't touch drizzle. Must run against PG.
  it("listDecidedUnresumed runs against postgres and returns decided-but-parked rows", async () => {
    // Park the shared case so the inner join on case status matches.
    await raw!.db
      .update(cases)
      .set({ status: "waiting_for_approval" })
      .where(sql`${cases.id} = ${caseId}`);
    const result = await runLive(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sample());
        const approved = yield* svc.approve({
          id: created.id,
          decidedBy: UserId(randomUUID()),
        });
        // Cutoff in the future so the just-decided row qualifies. With the
        // old raw-Date code this call THREW; with lt() it resolves.
        const found = yield* svc.listDecidedUnresumed({
          decidedBefore: new Date(Date.now() + 60 * 60_000),
        });
        return { approvedId: approved.id, found };
      }),
    );
    expect(result.found.map((a) => a.id)).toContain(result.approvedId);
    for (const a of result.found) {
      expect(["approved", "rejected"]).toContain(a.status);
    }
  });

  // The reminder sweep's due-query is operator-based (lt/gte/isNull) for the
  // same Date-encoding safety as listDecidedUnresumed. Exercise it against real
  // PG so the grace/window bounds, the isNull-vs-interval branch, and the
  // recordReminderSent stamp are validated end-to-end (the in-memory Test layer
  // re-implements this logic and can't catch a SQL/encoder drift).
  it("listPendingNeedingReminder honors grace/window/interval + recordReminderSent (real PG)", async () => {
    const now = new Date();
    const withinWindow = {
      createdBefore: new Date(now.getTime() + 60 * 60_000), // row is "old enough"
      createdAfter: new Date(now.getTime() - 7 * 24 * 60 * 60_000), // inside 7d
    };
    const result = await runLive(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        const created = yield* svc.create(sample());
        const id = created.id;

        // Never reminded → due.
        const due1 = yield* svc.listPendingNeedingReminder({
          ...withinWindow,
          remindedBefore: new Date(now.getTime() - 24 * 60 * 60_000),
        });

        // Older than the window (createdAfter in the future) → not due.
        const outOfWindow = yield* svc.listPendingNeedingReminder({
          createdBefore: new Date(now.getTime() + 60 * 60_000),
          createdAfter: new Date(now.getTime() + 60 * 60_000),
          remindedBefore: new Date(now.getTime() - 24 * 60 * 60_000),
        });

        // Stamp a reminder; the interval gate then excludes it...
        yield* svc.recordReminderSent(id, now);
        const dueInsideInterval = yield* svc.listPendingNeedingReminder({
          ...withinWindow,
          remindedBefore: new Date(now.getTime() - 24 * 60 * 60_000),
        });

        // ...until the interval elapses (remindedBefore in the future).
        const dueAfterInterval = yield* svc.listPendingNeedingReminder({
          ...withinWindow,
          remindedBefore: new Date(now.getTime() + 25 * 60 * 60_000),
        });

        return {
          id,
          due1: due1.map((a) => a.id),
          outOfWindow: outOfWindow.map((a) => a.id),
          dueInsideInterval: dueInsideInterval.map((a) => a.id),
          dueAfterInterval: dueAfterInterval.map((a) => a.id),
        };
      }),
    );
    expect(result.due1).toContain(result.id);
    expect(result.outOfWindow).not.toContain(result.id);
    expect(result.dueInsideInterval).not.toContain(result.id);
    expect(result.dueAfterInterval).toContain(result.id);
  });
});
