import { afterAll, describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  AgentId,
  ApprovalId,
  TicketId,
  TenantId,
  ThreadId,
  UserId,
} from "@support-agent/agent-core";
import {
  ApprovalService,
  AuditLogService,
  TicketRepository,
  TimerService,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  AuditLogServiceLive,
  approvals as approvalsTable,
  auditLog as auditLogTable,
  TicketRepositoryLive,
  DbClientLive,
  tickets as ticketsTable,
  makeDbClient,
  tenants,
  timers as timersTable,
  TimerServiceLive,
} from "../src/index.js";

// Audit D9 (optional-but-enforced tenant scoping on bare-id repo methods)
// and D2 (provider stamp on tickets + provider-aware thread lookups), against
// the real Live impls. Gated on DATABASE_URL.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("tenant scoping + provider stamp (integration)", () => {
  const client = makeDbClient({ databaseUrl: databaseUrl! });
  const { db } = client;

  const seededTenants: string[] = [];

  afterAll(async () => {
    if (seededTenants.length > 0) {
      // FK order: approvals/audit_log reference tickets without cascade;
      // timers + state transitions cascade with the ticket delete.
      await db
        .delete(approvalsTable)
        .where(inArray(approvalsTable.tenantId, seededTenants));
      await db
        .delete(auditLogTable)
        .where(inArray(auditLogTable.tenantId, seededTenants));
      await db
        .delete(ticketsTable)
        .where(inArray(ticketsTable.tenantId, seededTenants));
      await db.delete(tenants).where(inArray(tenants.id, seededTenants));
    }
    await client.close();
  });

  const dbLayer = DbClientLive({ databaseUrl: databaseUrl! });
  const layer = Layer.mergeAll(
    TicketRepositoryLive,
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

  const createTicket = (tenantId: TenantId, threadId?: string, provider?: never) =>
    Effect.gen(function* () {
      const repo = yield* TicketRepository;
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
        const repo = yield* TicketRepository;
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
      .select({ provider: ticketsTable.provider })
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows[0]?.provider).toBe("outlook");
  });

  it("D2: create derives the stamp from a namespaced threadId when not given", async () => {
    const tenantId = await seedTenant();
    const created = await run(createTicket(tenantId, `gmail:${randomUUID()}`));
    const rows = await db
      .select({ provider: ticketsTable.provider })
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows[0]?.provider).toBe("gmail");
  });

  it("D2: findThreadProvider returns the stamp (and null when unstamped)", async () => {
    const tenantId = await seedTenant();
    const threadId = `imap:<${randomUUID()}@x.com>`;
    await run(createTicket(tenantId, threadId));
    const legacyThread = randomUUID(); // un-namespaced → no stamp derived
    await run(createTicket(tenantId, legacyThread));
    const [stamped, unstamped, missing] = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
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
    const created = await run(createTicket(tenantId, threadId));
    const [match, mismatch] = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return [
          yield* repo.findByThreadId(tenantId, ThreadId(threadId), "gmail"),
          yield* repo.findByThreadId(tenantId, ThreadId(threadId), "outlook"),
        ] as const;
      }),
    );
    expect(match?.id).toBe(created.id);
    expect(mismatch).toBeNull();
  });

  it("D2: isolates the same provider thread id across mailboxes", async () => {
    const tenantId = await seedTenant();
    const threadId = ThreadId(`gmail:${randomUUID()}`);
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const first = yield* repo.create({
          tenantId,
          channel: "email",
          currentAgentId: agent,
          threadId,
          provider: "gmail",
          mailbox: "first@merchant.com",
        });
        const second = yield* repo.create({
          tenantId,
          channel: "email",
          currentAgentId: agent,
          threadId,
          provider: "gmail",
          mailbox: "second@merchant.com",
        });
        return {
          first,
          second,
          foundFirst: yield* repo.findByThreadId(
            tenantId,
            threadId,
            "gmail",
            "first@merchant.com",
          ),
          foundSecond: yield* repo.findByThreadId(
            tenantId,
            threadId,
            "gmail",
            "second@merchant.com",
          ),
        };
      }),
    );

    expect(result.first.id).not.toBe(result.second.id);
    expect(result.foundFirst?.id).toBe(result.first.id);
    expect(result.foundSecond?.id).toBe(result.second.id);
  });

  // ============================================================
  // D9 — TicketRepository
  // ============================================================

  it("D9: getById enforces tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createTicket(tenantA));
    const ok = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* repo.getById(created.id, tenantA);
      }),
    );
    expect(ok.id).toBe(created.id);
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* repo.getById(created.id, tenantB);
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    if (Exit.isFailure(cross)) {
      const err = (cross.cause as { error?: { _tag?: string } }).error;
      expect(err?._tag).toBe("TicketNotFound");
    }
  });

  it("D9: update enforces tenantId when present (no cross-tenant write)", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createTicket(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* repo.update(created.id, { summary: "pwned" }, tenantB);
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    const rows = await db
      .select({ summary: ticketsTable.summary })
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows[0]?.summary).toBeNull();
    // Scoped to the right tenant it works.
    const updated = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* repo.update(created.id, { summary: "fine" }, tenantA);
      }),
    );
    expect(updated.summary).toBe("fine");
  });

  it("D9: transitionStatus enforces opts.tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const created = await run(createTicket(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        return yield* repo.transitionStatus(created.id, "triaging", {
          tenantId: tenantB,
        });
      }),
    );
    expect(Exit.isFailure(cross)).toBe(true);
    const rows = await db
      .select({ status: ticketsTable.status })
      .from(ticketsTable)
      .where(eq(ticketsTable.id, created.id));
    expect(rows[0]?.status).toBe("new");
    const ok = await run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
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
    const c = await run(createTicket(tenantA));
    const approval = await run(
      Effect.gen(function* () {
        const svc = yield* ApprovalService;
        return yield* svc.create({
          tenantId: tenantA,
          ticketId: TicketId(c.id),
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
  // D9 — AuditLogService.forTicket
  // ============================================================

  it("D9: forTicket scopes by tenantId when present", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createTicket(tenantA));
    await run(
      Effect.gen(function* () {
        const audit = yield* AuditLogService;
        yield* audit.record({
          tenantId: tenantA,
          ticketId: TicketId(c.id),
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
          yield* audit.forTicket(TicketId(c.id), { tenantId: tenantA }),
          yield* audit.forTicket(TicketId(c.id), { tenantId: tenantB }),
        ] as const;
      }),
    );
    expect(scoped.length).toBe(1);
    expect(cross.length).toBe(0);
  });

  // ============================================================
  // D9 — TimerService
  // ============================================================

  it("D9: schedule refuses a ticket outside the given tenant", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createTicket(tenantA));
    const cross = await runExit(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          ticketId: TicketId(c.id),
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
      .where(eq(timersTable.ticketId, c.id));
    expect(rows.length).toBe(0);

    const ok = await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          ticketId: TicketId(c.id),
          fireAt: new Date(Date.now() + 60_000),
          reason: "follow_up",
          tenantId: tenantA,
        });
      }),
    );
    expect(ok.ticketId).toBe(c.id);
  });

  it("D9: cancelOpenForTicket scoped to the wrong tenant cancels nothing", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const c = await run(createTicket(tenantA));
    await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        return yield* svc.schedule({
          ticketId: TicketId(c.id),
          fireAt: new Date(Date.now() + 60_000),
          reason: "follow_up",
        });
      }),
    );
    const [crossCount, scopedCount] = await run(
      Effect.gen(function* () {
        const svc = yield* TimerService;
        const cross = yield* svc.cancelOpenForTicket(TicketId(c.id), {
          tenantId: tenantB,
        });
        const scoped = yield* svc.cancelOpenForTicket(TicketId(c.id), {
          tenantId: tenantA,
        });
        return [cross, scoped] as const;
      }),
    );
    expect(crossCount).toBe(0);
    expect(scopedCount).toBe(1);
  });
});
