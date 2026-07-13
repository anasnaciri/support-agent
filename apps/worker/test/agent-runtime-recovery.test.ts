import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  ContextTooLarge,
  InsufficientCredits,
  PermissionServiceDefault,
  ProviderUnavailable,
  TenantId,
  ToolOutputInvalid,
  ToolRegistryWith,
  UserId,
  defineTool,
  type AgentConfig,
  type DomainEvent,
  type LLMDecision,
} from "@support-agent/agent-core";
import { ticketUpdateContext } from "@support-agent/tools";
import {
  AgentRuntime,
  AgentRuntimeDefault,
  TicketAttachmentStoreTest,
  ApprovalLinkConfig,
  ApprovalService,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  TicketRepository,
  TicketRepositoryTest,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  DEFAULT_RETENTION_DAYS,
  LLMServiceFromFn,
  LLMServiceScripted,
  PlatformMailServiceTest,
  ProcessedMessageStoreTest,
  ShopifyServiceTest,
  TenantAgentOverridesServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  ToolExecutionStore,
  ToolExecutionStoreTest,
  TransactionRunnerPassthrough,
  AgentResolverTest,
} from "@support-agent/services";

// ------------------------------------------------------------
// Recovery / failure-path behavior for the runtime (audit C1, L4,
// L7, L8, L10, L13). Each test pins one rule:
//   - transient LLM errors → Failed retryable:true (worker retries)
//   - deterministic LLM errors → ticket parked in human_takeover
//   - max_turns / approved-tool-failed → ticket parked, not dangling
//   - approval resume: expiry, schema validation, policy deny,
//     duplicate-delivery short-circuit
//   - in-loop tool input validation (invalid_input pushed back)
//   - decision-level handoff respects the handoff allowlist
// ------------------------------------------------------------

const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
  baseUrl: "https://api.test.example",
  signingKey: "test-signing-key",
  ttlMs: 60_000,
});

const defaultTenantSettings = new TenantSettings({
  notificationEmail: null,
  refundPolicy: defaultRefundPolicy,
  discountPolicy: defaultDiscountPolicy,
  retentionDays: DEFAULT_RETENTION_DAYS,
  fulfillmentOperatorEscalationSheet: null,
  legalAcceptance: null,
});

const tenantRepoDefault = TenantRepositoryTest({
  settingsByTenant: new Map([[TenantId("tenant-acme"), defaultTenantSettings]]),
});

// A side-effecting tool whose executions the test can count, so we can
// assert "the tool did NOT run" on the blocked paths. Declares an
// input-derived idempotencyKey like the real money/message tools do.
const makeCountedTool = (counter: { count: number }) =>
  defineTool({
    name: "test.counted_action",
    description: "Test tool that records each execution.",
    inputSchema: Schema.Struct({ amount: Schema.Number }),
    outputSchema: Schema.Struct({ ok: Schema.Boolean }),
    risk: "communicate",
    defaultPermission: "ask",
    sideEffectClass: "external_message",
    idempotencyKey: (input) => `counted-${input.amount}`,
    execute: () =>
      Effect.sync(() => {
        counter.count += 1;
        return { ok: true };
      }),
  });

const makeFailingTool = () =>
  defineTool({
    name: "test.failing_action",
    description: "Test tool that always fails.",
    inputSchema: Schema.Struct({ note: Schema.String }),
    outputSchema: Schema.Struct({ ok: Schema.Boolean }),
    risk: "communicate",
    defaultPermission: "ask",
    sideEffectClass: "external_message",
    execute: () =>
      Effect.fail(
        new ToolOutputInvalid({ tool: "test.failing_action", issues: ["boom"] }),
      ),
  });

const recoveryAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: AgentId("recovery-test-agent"),
  promptTemplate: "Recovery test agent.",
  model: "test/model",
  tools: ["ticket.update_context", "test.counted_action", "test.failing_action"],
  handoffs: [],
  permissionOverrides: {},
  maxTurnsPerTick: 2,
  ...overrides,
});

const buildLayer = (
  llm: Layer.Layer<never, never, never> | ReturnType<typeof LLMServiceScripted>,
  agents: ReadonlyArray<AgentConfig>,
  toolList: ReadonlyArray<unknown>,
) => {
  const env = Layer.mergeAll(
    TicketRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest(agents as never),
    ToolRegistryWith(toolList as never),
    PermissionServiceDefault,
    llm as never,
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    approvalLinkLayer,
    PlatformMailServiceTest({}),
    TenantAgentOverridesServiceTest(),
    tenantRepoDefault,
    ProcessedMessageStoreTest,
    ToolExecutionStoreTest,
  );
  return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);
};

const customerReplied = (ticketId: string): DomainEvent => ({
  type: "customer.replied",
  ticketId: ticketId as never,
  payload: {
    threadId: "thread-recovery" as never,
    messageId: "msg-r1",
    from: { name: null, email: "cust@example.com" },
    to: [],
    subject: "Help",
    bodyText: "Hello, I need help.",
    bodyHtml: null,
    receivedAt: new Date(),
    attachments: [],
  },
});

const runWithTicket = <A>(
  layer: Layer.Layer<never, never, never>,
  program: (ticketId: string) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const created = yield* repo.create({
          tenantId: TenantId("tenant-acme"),
          channel: "email",
          currentAgentId: AgentId("recovery-test-agent"),
          subject: "Recovery test",
        });
        return yield* program(created.id);
      }),
      layer,
    ) as Effect.Effect<A, never, never>,
  );

describe("AgentRuntime — LLM failure classification (C1)", () => {
  it("returns Failed retryable:true on a transient provider error and does not move the ticket", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceFromFn(() =>
        Effect.fail(new ProviderUnavailable({ provider: "openrouter" as never })),
      ) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(out.result.type).toBe("Failed");
    if (out.result.type === "Failed") {
      expect(out.result.retryable).toBe(true);
    }
    // The ticket must stay where it was — a retry will pick it up.
    expect(out.fetched.status).toBe("new");
  });

  it("escalates to human_takeover on a deterministic LLM error (ContextTooLarge)", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceFromFn(() =>
        Effect.fail(new ContextTooLarge({ tokens: 1_000_000, limit: 200_000 })),
      ) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        return { result, fetched, entries };
      }),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.entries.map((e) => e.action)).toContain(
      "ticket.escalated_to_human",
    );
  });

  it("escalates to human_takeover (NOT a retryable Failed) when the LLM key is out of credits", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceFromFn(() =>
        Effect.fail(new InsufficientCredits({ provider: "openrouter" as never })),
      ) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        return { result, fetched, entries };
      }),
    );

    // Terminal — retrying replays the same out-of-credits request, so the
    // worker must NOT retry. Park for a human with a precise reason.
    expect(out.result.type).toBe("HumanTakeoverRequired");
    if (out.result.type === "HumanTakeoverRequired") {
      expect(out.result.reason).toBe("llm_insufficient_credits");
    }
    expect(out.fetched.status).toBe("human_takeover");
    const escalation = out.entries.find(
      (e) => e.action === "ticket.escalated_to_human",
    );
    expect(escalation?.details["reason"]).toBe("llm_insufficient_credits");
  });
});

describe("AgentRuntime — dashboard retry (ticket.resumed)", () => {
  it("runs a tick with the thread id and prior context so a retried agent can act", async () => {
    const counter = { count: 0 };
    const seen: Array<unknown> = [];
    const layer = buildLayer(
      LLMServiceFromFn((req) => {
        seen.push(req.messages);
        return Effect.succeed({
          type: "final_message",
          text: "Retried and answered the customer.",
        } as const);
      }) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          const runtime = yield* AgentRuntime;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: AgentId("recovery-test-agent"),
            subject: "Where is my order?",
            threadId: "outlook:thread-retry-1" as never,
            context: { identifiedOrderId: "#1001" },
          });
          const result = yield* runtime.handleEvent({
            type: "ticket.resumed",
            ticketId: created.id,
            trigger: "dashboard_retry",
          });
          const fetched = yield* repo.getById(created.id);
          return { result, fetched };
        }),
        layer as never,
      ) as Effect.Effect<
        { result: { type: string }; fetched: { status: string } },
        never,
        never
      >,
    );

    // The tick ran to completion and resolved the ticket.
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    // The agent was handed everything it needs to re-orient: the thread
    // id (to wire conversation.* tools), the retry trigger, and the
    // context patches from the previous attempt.
    const firstUser = (seen[0] as Array<{ role: string; content: unknown }>)
      .find((m) => m.role === "user");
    const text = String(firstUser?.content);
    expect(text).toContain("threadId=outlook:thread-retry-1");
    expect(text).toContain("dashboard_retry");
    expect(text).toContain("#1001");
    expect(text).toContain("Where is my order?");
  });
});

describe("AgentRuntime — dangling HumanTakeoverRequired paths (L4)", () => {
  it("transitions the ticket to human_takeover when max turns are exhausted", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([
        {
          type: "tool_call",
          callId: "t0",
          tool: "ticket.update_context",
          input: { notes: "turn 0" },
        },
        {
          type: "tool_call",
          callId: "t1",
          tool: "ticket.update_context",
          input: { notes: "turn 1" },
        },
      ]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });

  it("transitions the ticket to human_takeover when an approved tool fails", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.failing_action",
          proposedInput: { note: "will fail" },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        const result = yield* runtime.handleEvent({
          type: "approval.approved",
          approvalId: approval.id,
          ticketId: ticketId as never,
          managerId: UserId("manager-1"),
        });
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });
});

describe("AgentRuntime — approval resume guards (L7/L8/C2)", () => {
  const approvedEvent = (
    approvalId: string,
    ticketId: string,
  ): DomainEvent => ({
    type: "approval.approved",
    approvalId: approvalId as never,
    ticketId: ticketId as never,
    managerId: UserId("manager-1"),
  });

  it("executes a stale (past-expiry) pending approval — tool age never blocks", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          // Drafted over a day ago. Approval drafts no longer expire by
          // age for any tool, so resume must still run the gated tool.
          expiresAt: new Date(Date.now() - 60_000),
        });
        const result = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(counter.count).toBe(1);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
  });

  it("parks when an approved tool is no longer registered", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        yield* repo.transitionStatus(ticketId as never, "waiting_for_approval", {
          reason: "test",
          tenantId: TenantId("tenant-acme"),
        });
        const result = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        return { result, fetched, entries };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    const escalation = out.entries.find(
      (entry) => entry.action === "ticket.escalated_to_human",
    );
    expect(escalation?.details["reason"]).toBe("approved_tool_unavailable");
  });

  it("does not execute an approved tool whose input no longer validates", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          // amount must be a number — this must be rejected at resume.
          proposedInput: { amount: "not-a-number" },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        const result = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });

  it("does not execute an approved tool the policy now denies", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [
        recoveryAgent({
          permissionOverrides: { "test.counted_action": "deny" },
        }),
      ],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        const result = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });

  it("holds a stale approval.approved delivery after human takeover without executing the tool", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        yield* repo.transitionStatus(ticketId as never, "human_takeover", {
          reason: "manager takeover",
          tenantId: TenantId("tenant-acme"),
        });
        const before = yield* repo.getById(ticketId as never);
        const result = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        return { before, result, fetched, entries };
      }),
    );

    expect(out.before.status).toBe("human_takeover");
    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("PausedForHumanTakeover");
    expect(out.fetched.status).toBe("human_takeover");
    expect(
      out.entries.some(
        (entry) => entry.action === "approval.stale_delivery_skipped",
      ),
    ).toBe(true);
  });

  it("short-circuits a duplicate approval.approved delivery on an already-resolved ticket", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        // First delivery executes and resolves the ticket.
        const first = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const afterFirst = counter.count;
        // Re-delivery of the same job (pg-boss at-least-once).
        const second = yield* runtime.handleEvent(
          approvedEvent(approval.id, ticketId),
        );
        const fetched = yield* repo.getById(ticketId as never);
        return { first, second, afterFirst, fetched };
      }),
    );

    expect(out.first.type).toBe("Completed");
    expect(out.afterFirst).toBe(1);
    expect(out.second.type).toBe("Completed");
    // The gated tool must NOT run a second time.
    expect(counter.count).toBe(1);
    expect(out.fetched.status).toBe("resolved");
  });
});

describe("AgentRuntime — at-least-once idempotency (audit C2/C3)", () => {
  it("skips the gated tool when an execution marker exists, but still resolves the ticket", async () => {
    // Simulates the crash window: the tool tx committed (refund issued,
    // marker recorded) but the worker died before the resolve tx — the
    // re-delivered approval.approved must NOT re-execute the tool, yet
    // must complete the resolve step.
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        const executions = yield* ToolExecutionStore;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "test",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        // The marker the crashed run would have committed (semantic key,
        // scoped to THIS approval delivery — `appr:<approvalId>`).
        yield* executions.record({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          callId: `appr:${approval.id}:test.counted_action:counted-5`,
          tool: "test.counted_action",
          resultOk: true,
        });
        const result = yield* runtime.handleEvent({
          type: "approval.approved",
          approvalId: approval.id,
          ticketId: ticketId as never,
          managerId: UserId("manager-1"),
        });
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
  });

  it("deduplicates a redelivered message.received tick", async () => {
    const counter = { count: 0 };
    // Exactly enough script for ONE tick; a second loop run would
    // exhaust the script and die. A fresh ticket created from
    // message.received routes to support-triage, so register one.
    const layer = buildLayer(
      LLMServiceScripted([
        { type: "final_message", text: "handled" },
      ]) as never,
      [recoveryAgent(), recoveryAgent({ id: AgentId("support-triage") })],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const inbound: DomainEvent = {
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "outlook:thread-c3" as never,
      payload: {
        threadId: "outlook:thread-c3" as never,
        messageId: "msg-c3-1",
        from: { name: null, email: "cust@example.com" },
        to: [],
        subject: "Help",
        bodyText: "Hello",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [],
      },
    };

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const first = yield* runtime.handleEvent(inbound);
          const second = yield* runtime.handleEvent(inbound);
          const row = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "outlook:thread-c3" as never,
          );
          const entries = row ? yield* audit.forTicket(row.id) : [];
          return { first, second, row, entries };
        }),
        layer as never,
      ) as Effect.Effect<
        {
          first: { type: string };
          second: { type: string };
          row: { status: string } | null;
          entries: ReadonlyArray<{ action: string }>;
        },
        never,
        never
      >,
    );

    expect(out.first).toEqual({ type: "Completed" });
    // The duplicate must not run another agent loop (the script would
    // have died) — it short-circuits cleanly.
    expect(out.second.type).toBe("Completed");
    expect(out.row?.status).toBe("resolved");
    expect(
      out.entries.filter((e) => e.action === "event.received"),
    ).toHaveLength(1);
  });

  it("skips an in-loop side-effecting tool whose idempotency key already executed", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([
        {
          type: "tool_call",
          callId: "redelivered-0",
          tool: "test.counted_action",
          input: { amount: 5 },
        },
        { type: "final_message", text: "done" },
      ]) as never,
      [
        recoveryAgent({
          permissionOverrides: { "test.counted_action": "allow" },
        }),
      ],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const executions = yield* ToolExecutionStore;
        // The same semantic action already executed in a prior (crashed)
        // run of THIS tick — same `customer.replied` delivery, so the marker
        // is scoped to its message id (`msg:msg-r1`).
        yield* executions.record({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          callId: "msg:msg-r1:test.counted_action:counted-5",
          tool: "test.counted_action",
          resultOk: true,
        });
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        return { result };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("Completed");
  });

  it("re-runs a side-effecting tool on a SECOND inbound message even when its idempotency key matches the first (no cross-delivery dedup)", async () => {
    // Regression for the resolved-ticket silent-drop bug: a customer replied
    // on a thread the agent had already answered, the agent re-drafted the
    // reply with the SAME idempotency key (draftId), and the ticket-scoped C2
    // marker from the first send wrongly deduped it — so nothing went out.
    // Two DISTINCT inbound messages (different messageId) must both run the
    // action; only a redelivery of the SAME message dedups.
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([
        // Tick 1 (message msg-1) → run the action, resolve.
        {
          type: "tool_call",
          callId: "t1",
          tool: "test.counted_action",
          input: { amount: 5 },
        },
        { type: "final_message", text: "done 1" },
        // Tick 2 (message msg-2, same thread, ticket now resolved) → run the
        // SAME action (same idempotency key) again, resolve.
        {
          type: "tool_call",
          callId: "t2",
          tool: "test.counted_action",
          input: { amount: 5 },
        },
        { type: "final_message", text: "done 2" },
      ]) as never,
      [
        recoveryAgent({
          id: AgentId("support-triage"),
          permissionOverrides: { "test.counted_action": "allow" },
        }),
      ],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const inbound = (messageId: string): DomainEvent => ({
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "gmail:thread-reopen" as never,
      payload: {
        threadId: "gmail:thread-reopen" as never,
        messageId,
        from: { name: null, email: "cust@example.com" },
        to: [],
        subject: "Where is my order?",
        bodyText: "still not here",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [],
      },
    });

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const first = yield* runtime.handleEvent(inbound("msg-1"));
          const firstRow = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "gmail:thread-reopen" as never,
          );
          const second = yield* runtime.handleEvent(inbound("msg-2"));
          const secondRow = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "gmail:thread-reopen" as never,
          );
          return {
            first,
            second,
            firstStatus: firstRow?.status,
            secondStatus: secondRow?.status,
          };
        }),
        layer as never,
      ) as Effect.Effect<
        {
          first: { type: string };
          second: { type: string };
          firstStatus: string | undefined;
          secondStatus: string | undefined;
        },
        never,
        never
      >,
    );

    expect(out.first.type).toBe("Completed");
    expect(out.firstStatus).toBe("resolved");
    expect(out.second.type).toBe("Completed");
    expect(out.secondStatus).toBe("resolved");
    // The SECOND inbound message re-ran the action — it was NOT falsely
    // deduped by the first message's marker. Before the delivery-scoping
    // fix this was 1 (the reply silently vanished).
    expect(counter.count).toBe(2);
  });
});

describe("AgentRuntime — round fencing (recovery hardening)", () => {
  it("does not execute a prior-round approved leftover when a new round's approval is approved (double-send guard)", async () => {
    // The production double-send: round 0 approved a reply that was skipped
    // (ticket taken over), leaving a zombie `approved` row; a later round drafted
    // + approved a fresh reply; the bundle swept BOTH → the customer got two
    // emails. Fencing by epoch makes only the current round's reply go out.
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;
        // Round 0: an approved-but-never-delivered reply (distinct idempotency
        // key so C2 can't be what saves us — only epoch fencing can).
        const zombie = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "round 0",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
          epoch: 0,
        });
        yield* approvals.approve({ id: zombie.id, decidedBy: UserId("m") });
        // The ticket advanced to round 1 (a resume bumped it).
        yield* repo.update(ticketId as never, { epoch: 1 }, TenantId("tenant-acme"));
        // Round 1: fresh reply, approved.
        const current = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 7 },
          reasoning: "round 1",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
          epoch: 1,
        });
        yield* approvals.approve({ id: current.id, decidedBy: UserId("m") });
        const result = yield* runtime.handleEvent({
          type: "approval.approved",
          approvalId: current.id,
          ticketId: ticketId as never,
          managerId: UserId("m"),
        });
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched, count: counter.count };
      }),
    );

    // Only the current round's reply went out — NOT the prior round's zombie.
    expect(out.count).toBe(1);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
  });

  it("ignores a rejection for a prior-round approval instead of forcing human_takeover (stale-reject storm guard)", async () => {
    // The production non-send: replayed rejections of OLD approvals slammed a
    // ticket that had moved on into human_takeover, which then blocked its
    // already-approved reply from ever sending.
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const approvals = yield* ApprovalService;
        // Round 0: an approval that was rejected long ago.
        const old = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "round 0",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
          epoch: 0,
        });
        yield* approvals.reject({ id: old.id, decidedBy: UserId("m") });
        // The ticket advanced to round 1 and now waits on a fresh approval.
        yield* repo.update(ticketId as never, { epoch: 1 }, TenantId("tenant-acme"));
        const current = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 7 },
          reasoning: "round 1",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
          epoch: 1,
        });
        yield* repo.transitionStatus(ticketId as never, "waiting_for_approval", {
          reason: "round 1 pending",
          tenantId: TenantId("tenant-acme"),
        });
        // A STALE rejected event for the round-0 approval is replayed.
        const result = yield* runtime.handleEvent({
          type: "approval.rejected",
          approvalId: old.id,
          ticketId: ticketId as never,
          managerId: UserId("m"),
        });
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        const currentAfter = yield* approvals.getById(
          current.id,
          TenantId("tenant-acme"),
        );
        return {
          result,
          fetched,
          actions: entries.map((e) => e.action),
          currentStatus: currentAfter.status,
        };
      }),
    );

    // The stale reject is a no-op: the ticket stays parked on its live approval.
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.actions).toContain("approval.ignored_stale");
    expect(out.actions).not.toContain("ticket.escalated_to_human");
    expect(out.currentStatus).toBe("pending");
  });

  it("still escalates to human_takeover when the CURRENT round's approval is rejected", async () => {
    // Positive control: the normal reject path is unchanged.
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([]) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const approvals = yield* ApprovalService;
        const current = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("recovery-test-agent"),
          tool: "test.counted_action",
          proposedInput: { amount: 5 },
          reasoning: "current",
          riskLevel: "medium",
          expiresAt: new Date(Date.now() + 60_000),
        });
        yield* repo.transitionStatus(ticketId as never, "waiting_for_approval", {
          reason: "pending",
          tenantId: TenantId("tenant-acme"),
        });
        const result = yield* runtime.handleEvent({
          type: "approval.rejected",
          approvalId: current.id,
          ticketId: ticketId as never,
          managerId: UserId("m"),
        });
        const fetched = yield* repo.getById(ticketId as never);
        const entries = yield* audit.forTicket(ticketId as never);
        return { result, fetched, actions: entries.map((e) => e.action) };
      }),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.actions).toContain("ticket.escalated_to_human");
  });
});

describe("AgentRuntime — reopen on customer reply (resolved → in_progress)", () => {
  it("reopens a resolved ticket and audits ticket.reopened when the customer replies", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([
        { type: "final_message", text: "resolved first" },
        { type: "final_message", text: "re-engaged" },
      ]) as never,
      [recoveryAgent({ id: AgentId("support-triage") })],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const inbound = (messageId: string): DomainEvent => ({
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "gmail:thread-reopen-2" as never,
      payload: {
        threadId: "gmail:thread-reopen-2" as never,
        messageId,
        from: { name: null, email: "cust@example.com" },
        to: [],
        subject: "Help",
        bodyText: "anything else?",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [],
      },
    });

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const audit = yield* AuditLogService;
          yield* runtime.handleEvent(inbound("msg-1"));
          const afterFirst = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "gmail:thread-reopen-2" as never,
          );
          yield* runtime.handleEvent(inbound("msg-2"));
          const entries = afterFirst ? yield* audit.forTicket(afterFirst.id) : [];
          return {
            firstStatus: afterFirst?.status,
            actions: entries.map((e) => e.action),
          };
        }),
        layer as never,
      ) as Effect.Effect<
        { firstStatus: string | undefined; actions: ReadonlyArray<string> },
        never,
        never
      >,
    );

    expect(out.firstStatus).toBe("resolved");
    // The second inbound flips the resolved ticket back to in_progress with a
    // visible reopen marker before the agent re-runs.
    expect(out.actions.filter((a) => a === "ticket.reopened")).toHaveLength(1);
  });
});

describe("AgentRuntime — in-loop guards (L10/L13)", () => {
  it("pushes invalid_input back to the model instead of executing a schema-invalid tool call", async () => {
    const counter = { count: 0 };
    const layer = buildLayer(
      LLMServiceScripted([
        {
          type: "tool_call",
          callId: "bad0",
          tool: "test.counted_action",
          input: { amount: "not-a-number" },
        },
        { type: "final_message", text: "done" },
      ]) as never,
      [
        recoveryAgent({
          permissionOverrides: { "test.counted_action": "allow" },
        }),
      ],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        return { result };
      }),
    );

    expect(counter.count).toBe(0);
    expect(out.result.type).toBe("Completed");
  });

  it("does not resolve a ticket a manager took over mid-tick (audit L1)", async () => {
    // The race: guard 2.95 passed (ticket was active at tick start), the
    // manager clicks Take over while the LLM call is in flight, and the
    // loop's final_message branch then writes human_takeover → resolved
    // from its stale in-memory status — un-parking the ticket the manager
    // just claimed. The transition matrix must block it.
    const counter = { count: 0 };
    let repoHandle: {
      transitionStatus: (
        id: never,
        status: string,
        opts: { reason: string },
      ) => Effect.Effect<unknown, unknown>;
    } | null = null;
    let takeoverTicketId: string | null = null;
    const layer = buildLayer(
      LLMServiceFromFn(() =>
        Effect.promise(async () => {
          // Simulate the dashboard takeover landing mid-LLM-call.
          if (repoHandle && takeoverTicketId) {
            await Effect.runPromise(
              repoHandle.transitionStatus(
                takeoverTicketId as never,
                "human_takeover",
                { reason: "manager takeover (test)" },
              ) as Effect.Effect<unknown, never, never>,
            );
          }
          return { type: "final_message", text: "all done" } as const;
        }),
      ) as never,
      [recoveryAgent()],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        repoHandle = repo as never;
        takeoverTicketId = ticketId;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    // The manager keeps the ticket.
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.result.type).toBe("PausedForHumanTakeover");
  });

  it("blocks a decision-level handoff to an agent not in the handoff allowlist", async () => {
    const counter = { count: 0 };
    const otherAgent = recoveryAgent({ id: AgentId("other-agent") });
    const decisions: ReadonlyArray<LLMDecision> = [
      {
        type: "handoff",
        targetAgent: AgentId("other-agent"),
        reason: "not allowed",
      },
      { type: "final_message", text: "done" },
    ];
    const layer = buildLayer(
      LLMServiceScripted(decisions) as never,
      [recoveryAgent(), otherAgent],
      [ticketUpdateContext, makeCountedTool(counter), makeFailingTool()],
    );

    const out = await runWithTicket(layer as never, (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const result = yield* runtime.handleEvent(customerReplied(ticketId));
        const fetched = yield* repo.getById(ticketId as never);
        return { result, fetched };
      }),
    );

    expect(out.result.type).toBe("Completed");
    // The ticket must still belong to the original agent.
    expect(out.fetched.currentAgentId).toBe("recovery-test-agent");
  });
});

describe("AgentRuntime — IMAP reply thread correlation (message-id index)", () => {
  it("correlates a reply to its existing ticket via the message-id index when the derived thread-root differs", async () => {
    // Regression for the IMAP "RE:" duplicate-ticket bug: a customer reply whose
    // mail client reordered / truncated the `References` chain derives a
    // DIFFERENT `imap:<root>` thread-id than the ticket was created with, so the
    // exact `findByThreadId` lookup misses and (before this fix) a duplicate
    // ticket was minted per reply. The reply's In-Reply-To still cites the first
    // inbound message, which the runtime recorded in the message-id index on
    // accept — so it must resolve back to the original ticket.
    const layer = buildLayer(
      LLMServiceScripted([
        { type: "final_message", text: "answered 1" },
        { type: "final_message", text: "answered 2" },
      ]) as never,
      [recoveryAgent({ id: AgentId("support-triage") })],
      [ticketUpdateContext, makeCountedTool({ count: 0 }), makeFailingTool()],
    );

    // First inbound: thread-root "root-1", own Message-ID "m1".
    const first: DomainEvent = {
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "imap:root-1" as never,
      payload: {
        threadId: "imap:root-1" as never,
        messageId: "m1",
        from: { name: null, email: "cust@example.com" },
        to: [],
        subject: "Order help",
        bodyText: "where is my order",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [],
      },
    };

    // The reply: a client-mangled chain makes the connector derive "root-2"
    // (≠ "root-1"), but In-Reply-To still points at the first message "m1".
    const reply: DomainEvent = {
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "imap:root-2" as never,
      payload: {
        threadId: "imap:root-2" as never,
        messageId: "m2",
        inReplyTo: "m1",
        references: ["root-2", "m1"],
        from: { name: null, email: "cust@example.com" },
        to: [],
        subject: "RE: Order help",
        bodyText: "any update?",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [],
      },
    };

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const r1 = yield* runtime.handleEvent(first);
          const ticketA = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "imap:root-1" as never,
          );
          const r2 = yield* runtime.handleEvent(reply);
          const byRoot1 = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "imap:root-1" as never,
          );
          const byRoot2 = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "imap:root-2" as never,
          );
          const byReplyId = yield* repo.findByMessageIds(
            TenantId("tenant-acme"),
            ["m2"],
          );
          const entries = ticketA ? yield* audit.forTicket(ticketA.id) : [];
          return {
            r1,
            r2,
            ticketAId: ticketA?.id,
            byRoot1Id: byRoot1?.id,
            byRoot2,
            byReplyId: byReplyId?.id,
            received: entries.filter((e) => e.action === "event.received").length,
          };
        }),
        layer as never,
      ) as Effect.Effect<
        {
          r1: { type: string };
          r2: { type: string };
          ticketAId: string | undefined;
          byRoot1Id: string | undefined;
          byRoot2: { id: string } | null;
          byReplyId: string | undefined;
          received: number;
        },
        never,
        never
      >,
    );

    expect(out.r1.type).toBe("Completed");
    expect(out.r2.type).toBe("Completed");
    // No duplicate ticket was created for the reply's derived root.
    expect(out.byRoot2).toBeNull();
    // Both messages landed on the SAME original ticket.
    expect(out.byRoot1Id).toBe(out.ticketAId);
    expect(out.byReplyId).toBe(out.ticketAId);
    // The original ticket saw two inbound events (original + reply).
    expect(out.received).toBe(2);
  });
});
