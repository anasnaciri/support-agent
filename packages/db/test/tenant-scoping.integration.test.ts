import { afterAll, describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  AgentId,
  ApprovalId,
  CaseId,
  TenantId,
  ThreadId,
  UserId,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  AuditLogService,
  CaseRepository,
  TimerService,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  AuditLogServiceLive,
  approvals as approvalsTable,
  auditLog as auditLogTable,
  CaseRepositoryLive,
  DbClientLive,
  cases as casesTable,
  makeDbClient,
  tenants,
  timers as timersTable,
  TimerServiceLive,
} from "../src/index.js";

// Audit D9 (optional-but-enforced tenant scoping on bare-id repo methods)
// and D2 (provider stamp on cases + provider-aware thread lookups), against
// the real Live impls. Gated on DATABASE_URL.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("tenant scoping + provider stamp (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      // FK order: approvals/audit_log reference cases without cascade;
      // timers + state transitions cascade with the case delete.
      await db
        .delete(approvalsTable)
        .where(inArray(approvalsTable.tenantId, seededTenants));
      await db
        .delete(auditLogTable)
        .where(inArray(auditLogTable.tenantId, seededTenants));
      await db
        .delete(casesTable)
        .where(inArray(casesTable.tenantId, seededTenants));
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const dbLayer = DbClientLive({ databaseUrl: databaseUrl! });
  const layer = Layer.mergeAll(
    CaseRepositoryLive,
    ApprovalServiceLive,
    AuditLogServiceLive,
    TimerServiceLive,
  ).pipe(Layer.provide(dbLayer));

  const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
    Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E, never>);
  const runExit = <A, E>(eff: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExit(
      Effect.provide(eff, layer) as Effect.Effect<A, E, never>,
    );

  const seedTenant = async (): Promise<TenantId> => {
    const id = randomUUID();
    await db.insert(tenants).values({ id, name: "Tenant Scoping Test" });
    seededTenants.push(id);
    return TenantId(id);
  };

  const agent = AgentId("support-triage");

  const createCase = (tenantId: TenantId, threadId?: string, provider?: never) =>
    Effect.gen(function* () {
      const repo = yield* CaseRepository;
      return yield* repo.create({
        tenantId,
        channel: "email",
        currentAgentId: agent,
        ...(threadId !== undefined ? { threadId: ThreadId(threadId) } : {}),
        ...(provider !== undefined ? { provider } : {}),
      } as never);
    });

  // ============================================================
  // D2 — provider stamp + provider-aware thread lookup
  // ============================================================

  it("D2: create stamps the explicit provider", async () => {
    const tenantId = await seedTenant();
    const created = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.create({
          tenantId,
          channel: "email",
          currentAgentId: agent,
          threadId: ThreadId(`outlook:${randomUUID()}`),
          provider: "outlook",
        } as never);
      }),
    );
    const rows = await db
      .select({ provider: casesTable.provider })
      .from(casesTable)
      .where(eq(casesTable.id, created.id));
    expect(rows[0]?.provider).toBe("outlook");
  });

  it("D2: create derives the stamp from a namespaced threadId when not given", async () => {
    const tenantId = await seedTenant();
    const created = await run(createCase(tenantId, `gmail:${randomUUID()}`));
    const rows = await db
      .select({ provider: casesTable.provider })
      .from(casesTable)
      .where(eq(casesTable.id, created.id));
    expect(rows[0]?.provider).toBe("gmail");
  });

  it("D2: findThreadProvider returns the stamp (and null when unstamped)", async () => {
    const tenantId = await seedTenant();
    const threadId = `imap:<${randomUUID()}@x.com>`;
    await run(createCase(tenantId, threadId));
    const legacyThread = randomUUID(); // un-namespaced → no stamp derived
    await run(createCase(tenantId, legacyThread));
    const [stamped, unstamped, missing] = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return [
          yield* repo.findThreadProvider(tenantId, ThreadId(threadId)),
          yield* repo.findThreadProvider(tenantId, ThreadId(legacyThread)),
          yield* repo.findThreadProvider(tenantId, ThreadId("gmail:never")),
        ] as const;
      }),
    );
    expect(stamped).toBe("imap");
    expect(unstamped).toBeNull();
    expect(missing).toBeNull();
  });

  it("D2: findByThreadId scopes by provider when given", async () => {
    const tenantId = await seedTenant();
    const threadId = `gmail:${randomUUID()}`;
    const created = await run(createCase(tenantId, threadId));
    const [match, mismatch] = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return [
          yield* repo.findByThreadId(tenantId, ThreadId(threadId), "gmail"),
          yield* repo.findByThreadId(tenantId, ThreadId(threadId), "outlook"),
        ] as const;
      }),
    );
    expect(match?.id).toBe(created.id);
    expect(mismatch).toBeNull();
  });

  // ============================================================
  // D9 — CaseRepository
  // ============================================================

  it("D9: getById enforces tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createCase(tenantA));
    const ok = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.getById(created.id, tenantA);
      }),
    );
    expect(ok.id).toBe(created.id);
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.getById(created.id, tenantB);
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    if (Exit.isFailure(cross)) {
      const err = (cross.cause as { error?: { _tag?: string } }).error;
      expect(err?._tag).toBe("CaseNotFound");
    }
  });

  it("D9: update enforces tenantId when present (no cross-tenant write)", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createCase(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.update(created.id, { summary: "pwned" }, tenantB);
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    const rows = await db
      .select({ summary: casesTable.summary })
      .from(casesTable)
      .where(eq(casesTable.id, created.id));
    expect(rows[0]?.summary).toBeNull();
    // Scoped to the right tenant it works.
    const updated = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.update(created.id, { summary: "fine" }, tenantA);
      }),
    );
    expect(updated.summary).toBe("fine");
  });

  it("D9: transitionStatus enforces opts.tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createCase(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.transitionStatus(created.id, "triaging", {
          tenantId: tenantB,
        });
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    const rows = await db
      .select({ status: casesTable.status })
      .from(casesTable)
      .where(eq(casesTable.id, created.id));
    expect(rows[0]?.status).toBe("new");
    const ok = await run(
      Effect.gen(function* () {
        const repo = yield* CaseRepository;
        return yield* repo.transitionStatus(created.id, "triaging", {
          tenantId: tenantA,
        });
      }),
    );
    expect(ok.status).toBe("triaging");
  });

  // ============================================================
  // D9 — ApprovalService
  // ============================================================

  it("D9: approval getById/approve/reject enforce tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createCase(tenantA));
    const approval = await run(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.create({
          tenantId: tenantA,
          caseId: CaseId(c.id),
          agentId: agent,
          tool: "refund.create",
          proposedInput: { amount: 10 },
          reasoning: "test",
          riskLevel: "low",
          expiresAt: new Date(Date.now() + 60_000),
        });
      }),
    );

    const crossGet = await runExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.getById(ApprovalId(approval.id), tenantB);
      }),
    );
    expect(Exit.isFailure(crossGet)).toBe(true);

    const crossApprove = await runExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.approve({
          id: ApprovalId(approval.id),
          decidedBy: UserId(randomUUID()),
          tenantId: tenantB,
        });
      }),
    );
    expect(Exit.isFailure(crossApprove)).toBe(true);

    // Still pending — the cross-tenant approve must not have decided it.
    const scoped = await run(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.getById(ApprovalId(approval.id), tenantA);
      }),
    );
    expect(scoped.status).toBe("pending");

    const crossReject = await runExit(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.reject({
          id: ApprovalId(approval.id),
          decidedBy: UserId(randomUUID()),
          tenantId: tenantB,
        });
      }),
    );
    expect(Exit.isFailure(crossReject)).toBe(true);

    const decided = await run(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.approve({
          id: ApprovalId(approval.id),
          decidedBy: UserId(randomUUID()),
          tenantId: tenantA,
        });
      }),
    );
    expect(decided.status).toBe("approved");
  });

  // ============================================================
  // D9 — AuditLogService.forCase
  // ============================================================

  it("D9: forCase scopes by tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createCase(tenantA));
    await run(
      Effect.gen(function* () {
        const audit = yield* AuditLogService;
        yield* audit.record({
          tenantId: tenantA,
          caseId: CaseId(c.id),
          actor: { type: "system", id: null },
          action: "test.scoping",
          details: {},
        });
      }),
    );
    const [scoped, cross] = await run(
      Effect.gen(function* () {
        const audit = yield* AuditLogService;
        return [
          yield* audit.forCase(CaseId(c.id), { tenantId: tenantA }),
          yield* audit.forCase(CaseId(c.id), { tenantId: tenantB }),
        ] as const;
      }),
    );
    expect(scoped.length).toBe(1);
    expect(cross.length).toBe(0);
  });

  // ============================================================
  // D9 — TimerService
  // ============================================================

  it("D9: schedule refuses a case outside the given tenant", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createCase(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          caseId: CaseId(c.id),
          fireAt: new Date(Date.now() + 60_000),
          reason: "follow_up",
          tenantId: tenantB,
        });
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    const rows = await db
      .select({ id: timersTable.id })
      .from(timersTable)
      .where(eq(timersTable.caseId, c.id));
    expect(rows.length).toBe(0);

    const ok = await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          caseId: CaseId(c.id),
          fireAt: new Date(Date.now() + 60_000),
          reason: "follow_up",
          tenantId: tenantA,
        });
      }),
    );
    expect(ok.caseId).toBe(c.id);
  });

  it("D9: cancelOpenForCase scoped to the wrong tenant cancels nothing", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createCase(tenantA));
    await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          caseId: CaseId(c.id),
          fireAt: new Date(Date.now() + 60_000),
          reason: "follow_up",
        });
      }),
    );
    const [crossCount, scopedCount] = await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        const cross = yield* svc.cancelOpenForCase(CaseId(c.id), {
          tenantId: tenantB,
        });
        const scoped = yield* svc.cancelOpenForCase(CaseId(c.id), {
          tenantId: tenantA,
        });
        return [cross, scoped] as const;
      }),
    );
    expect(crossCount).toBe(0);
    expect(scopedCount).toBe(1);
  });
});
