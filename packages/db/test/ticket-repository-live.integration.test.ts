import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  AgentId,
  TenantId,
  ThreadId,
} from "@support-agent/agent-core";
import {
  TicketRepository,
  TicketStateConflict,
} from "@support-agent/services";
import {
  TicketRepositoryLive,
  DbClient,
  DbClientLive,
  ticketStateTransitions,
  tickets,
  tenants,
  makeDbClient,
} from "../src/index.js";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("TicketRepository (Live, integration)", () => {
  // direct client for raw cleanup
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();

  const liveLayer = Layer.provide(
    TicketRepositoryLive,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const runLive = <A, E>(
    eff: Effect.Effect<A, E, TicketRepository | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runLiveExit = <A, E>(
    eff: Effect.Effect<A, E, TicketRepository | DbClient>,
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
    await raw.db.delete(tickets).where(sql`${tickets.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("creates and reads a ticket", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
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

  it("transitionStatus writes ticket_state_transitions in the same tx", async () => {
    const threadId = `thread-${randomUUID()}`;
    const result = await runLive(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
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
        return { ticketId: c.id, transitioned };
      }),
    );
    expect(result.transitioned.status).toBe("resolved");
    expect(result.transitioned.resolvedAt).not.toBeNull();

    const transitionRows = await raw!.db
      .select()
      .from(ticketStateTransitions)
      .where(sql`${ticketStateTransitions.ticketId} = ${result.ticketId}`);
    expect(transitionRows.length).toBe(1);
    expect(transitionRows[0]?.fromStatus).toBe("new");
    expect(transitionRows[0]?.toStatus).toBe("resolved");
    expect(transitionRows[0]?.reason).toBe("integration-test");
  });

  it("transitionStatus rejects with TicketStateConflict when expected status mismatches", async () => {
    const exit = await runLiveExit(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
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
      expect(exit.cause.error).toBeInstanceOf(TicketStateConflict);
    }
  });

  it("recordMessageId + findByMessageIds correlate a reply, idempotently and tenant-scoped", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const messageId = `m-${randomUUID()}@host`;
        const c = yield* repo.create({
          tenantId: TenantId(tenantId),
          channel: "email",
          currentAgentId: AgentId("support-triage"),
          threadId: ThreadId(`thread-${randomUUID()}`),
        });
        yield* repo.recordMessageId({
          tenantId: TenantId(tenantId),
          ticketId: c.id,
          messageId,
          direction: "inbound",
        });
        // Re-recording the same id (redelivery) is a no-op (ON CONFLICT).
        yield* repo.recordMessageId({
          tenantId: TenantId(tenantId),
          ticketId: c.id,
          messageId,
          direction: "outbound",
        });
        const hit = yield* repo.findByMessageIds(TenantId(tenantId), [
          "absent@host",
          messageId,
        ]);
        const miss = yield* repo.findByMessageIds(TenantId(tenantId), [
          "absent@host",
        ]);
        const crossTenant = yield* repo.findByMessageIds(
          TenantId(randomUUID()),
          [messageId],
        );
        return { ticketId: c.id, hitId: hit?.id, miss, crossTenant };
      }),
    );
    expect(result.hitId).toBe(result.ticketId);
    expect(result.miss).toBeNull();
    expect(result.crossTenant).toBeNull();
  });
});
