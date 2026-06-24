import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  AgentRegistryWith,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type DomainEvent,
  type LLMDecision,
} from "@support-agent/agent-core";
import { supportTriage } from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
} from "@support-agent/tools";
import {
  AgentRuntime,
  AgentRuntimeDefault,
  ApprovalLinkConfig,
  LLMServiceScripted,
  PlatformMailServiceTest,
  ShopifyServiceTest,
  TenantAgentOverridesServiceTest,
  TransactionRunnerPassthrough,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  AuditLogServiceLive,
  CaseRepositoryLive,
  DbClient,
  DbClientLive,
  TenantRepositoryLive,
  TransactionRunnerLive,
  auditLog,
  cases,
  caseStateTransitions,
  makeDbClient,
  tenants,
} from "@support-agent/db";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("AgentRuntime + TransactionRunnerLive (audit-in-tx)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const terminalSupportTriage = {
    ...supportTriage,
    handoffs: [],
  };

  // Compose every Live impl onto a real DB.
  const dbLayer = DbClientLive({ databaseUrl: databaseUrl! });
  const repos = Layer.mergeAll(
    CaseRepositoryLive,
    AuditLogServiceLive,
    ApprovalServiceLive,
    TransactionRunnerLive,
  );
  const env = Layer.mergeAll(
    repos,
    AgentRegistryWith([terminalSupportTriage]),
    ToolRegistryWith([
      caseUpdateContext as never,
      caseUpdateStatus as never,
      // supportTriage now declares `agent.handoff` in its tool list;
      // ToolRegistry.schemasFor would fail with UnknownTool otherwise.
      agentHandoff as never,
    ]),
    PermissionServiceDefault,
    // Script that returns ONE tool call then a final_message. This fixture
    // registers support-triage as a terminal agent (handoffs: []) so the
    // runtime's final_message branch transitions to "resolved" + writes
    // case.resolved audit — all under one tx, atomic with the final state
    // change.
    LLMServiceScripted([
      {
        type: "tool_call" as const,
        callId: "c0",
        tool: "case.update_context",
        input: { classification: "where_is_order" },
      },
      { type: "final_message" as const, text: "done" },
    ] as ReadonlyArray<LLMDecision>),
    ShopifyServiceTest({}),
    PlatformMailServiceTest({}),
    TenantAgentOverridesServiceTest(),
    TenantRepositoryLive,
    Layer.succeed(ApprovalLinkConfig, {
      baseUrl: "https://api.test.example",
      signingKey: "test-signing-key",
      ttlMs: 60_000,
    }),
  );
  // Build dbLayer → satisfy env's DbClient dep → that's `envWithDb`, which
  // both AgentRuntime depends on AND tools yield from (case.update_status /
  // case.update_context yield CaseRepository inside `execute`). So we
  // expose `envWithDb` (not just the AgentRuntime layer) to the outer
  // fiber via `Layer.merge`, and merge in dbLayer so tests can use it too.
  const envWithDb = env.pipe(Layer.provide(dbLayer));
  const runtimeLayer = AgentRuntimeDefault.pipe(Layer.provide(envWithDb));
  const liveLayer = Layer.mergeAll(runtimeLayer, envWithDb, dbLayer);

  const run = <A, E>(
    eff: Effect.Effect<A, E, AgentRuntime | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "agent-tx-test" });
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

  it("end-to-end happy path commits case + audit + transitions atomically", async () => {
    const event: DomainEvent = {
      type: "ticket.created",
      tenantId: TenantId(tenantId),
      source: "api",
      payload: {
        subject: "Hi",
        body: "Where is my order?",
        customerEmail: null,
        metadata: {},
      },
    };

    const result = await run(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        return yield* runtime.handleEvent(event);
      }),
    );
    expect(result.type).toBe("Completed");

    // Pull all the persisted state for this tenant.
    const caseRows = await raw!.db
      .select()
      .from(cases)
      .where(sql`${cases.tenantId} = ${tenantId}`);
    expect(caseRows).toHaveLength(1);
    expect(caseRows[0]?.status).toBe("resolved");
    expect(caseRows[0]?.resolvedAt).not.toBeNull();

    const caseId = caseRows[0]!.id;

    const auditRows = await raw!.db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.caseId} = ${caseId}`);
    const actions = auditRows.map((r) => r.action);
    // event.received + 2 llm.decision + 1 tool.invoked + case.resolved
    expect(actions).toContain("event.received");
    expect(actions).toContain("tool.invoked");
    expect(actions).toContain("case.resolved");

    const transitionRows = await raw!.db
      .select()
      .from(caseStateTransitions)
      .where(sql`${caseStateTransitions.caseId} = ${caseId}`);
    // new → resolved (single transition through the final_message branch)
    expect(transitionRows.length).toBeGreaterThanOrEqual(1);
    expect(transitionRows.some((r) => r.toStatus === "resolved")).toBe(true);
  });
});
