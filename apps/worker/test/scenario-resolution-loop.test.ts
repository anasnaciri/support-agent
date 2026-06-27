import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  UserId,
  type AgentConfig,
  type LLMDecision,
} from "@support-agent/agent-core";
import { ALL_TOOLS } from "@support-agent/tools";
import { scenarioResolutionAgent } from "@support-agent/agents";
import type { ResolutionPolicy } from "@support-agent/services";
import {
  AgentResolverTest,
  AgentRuntime,
  AgentRuntimeDefault,
  ApprovalLinkConfig,
  ApprovalService,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseRepository,
  CaseRepositoryTest,
  ConversationServiceTest,
  LLMServiceScripted,
  makeConversationServiceTest,
  PlatformMailServiceTest,
  ShopifyServiceTest,
  TenantAgentOverridesServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  TransactionRunnerPassthrough,
  defaultDiscountPolicy,
  defaultRefundPolicy,
} from "@support-agent/services";

// ------------------------------------------------------------
// Shared stubs (mirrors apps/worker/test/agent-runtime.e2e.test.ts).
// ------------------------------------------------------------
const TENANT = "tenant-acme";
const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
  baseUrl: "https://api.test.example",
  signingKey: "test-signing-key",
  ttlMs: 60_000,
});
const platformMailNoop = PlatformMailServiceTest({});
const tenantOverridesEmpty = TenantAgentOverridesServiceTest();
const defaultTenantSettings = new TenantSettings({
  notificationEmail: null,
  refundPolicy: defaultRefundPolicy,
  discountPolicy: defaultDiscountPolicy,
  retentionDays: 730,
  supplierEscalationSheet: null,
  legalAcceptance: null,
});
const tenantRepoDefault = TenantRepositoryTest({
  settingsByTenant: new Map([[TenantId(TENANT), defaultTenantSettings]]),
});

// An autonomous-loop agent under the scenario agent's id, with three remedy/
// communication tools forced to `ask` so each call is QUEUED (not executed)
// and the loop must continue across all three before the agent stops.
const loopAgent = (
  overrides: Partial<AgentConfig> = {},
): AgentConfig => ({
  id: AgentId("scenario-resolution-agent"),
  name: "Scenario Resolution",
  description: "test loop agent",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  autonomousLoop: true,
  promptTemplate: "test",
  tools: [
    "merchant.notify",
    "refund.recommend",
    "conversation.reply",
    "case.update_context",
  ],
  permissionOverrides: {
    "merchant.notify": "ask",
    "refund.recommend": "ask",
    "conversation.reply": "ask",
  },
  handoffs: [],
  maxTurnsPerTick: 10,
  temperature: 0,
  ...overrides,
});

const makeLayer = (agent: AgentConfig, script: ReadonlyArray<LLMDecision>) => {
  const env = Layer.mergeAll(
    CaseRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([agent]),
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    LLMServiceScripted(script),
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    ConversationServiceTest({}),
    approvalLinkLayer,
    platformMailNoop,
    tenantOverridesEmpty,
    tenantRepoDefault,
  );
  return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);
};

const driveCase = (agent: AgentConfig, script: ReadonlyArray<LLMDecision>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* CaseRepository;
        const approvals = yield* ApprovalService;
        const audit = yield* AuditLogService;

        const created = yield* repo.create({
          tenantId: TenantId(TENANT),
          channel: "email",
          currentAgentId: agent.id,
          subject: "Need help",
          mailbox: "support@store.test",
        });

        const result = yield* runtime.handleEvent({
          type: "customer.replied",
          caseId: created.id,
          payload: {
            threadId: "thread-x" as never,
            messageId: "msg-1",
            from: { name: null, email: "cust@example.com" },
            to: [],
            subject: "Re: Need help",
            bodyText: "Please help with my order.",
            bodyHtml: null,
            receivedAt: new Date(),
            attachments: [],
          },
        });

        const fetched = yield* repo.getById(created.id);
        const pending = yield* approvals.listPending(TenantId(TENANT));
        const entries = yield* audit.forCase(created.id);
        return { result, fetched, pending, entries };
      }),
      makeLayer(agent, script),
    ),
  );

describe("scenario-resolution autonomous loop — queue + end-of-loop mapping", () => {
  it("queues every gated action and parks ONCE as a bundle at the end of the loop", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "q0",
        tool: "merchant.notify",
        input: { title: "Heads up", message: "Possible duplicate refund." },
      },
      {
        type: "tool_call",
        callId: "q1",
        tool: "refund.recommend",
        input: { orderId: "gid://shopify/Order/1001" },
      },
      {
        type: "tool_call",
        callId: "q2",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "We're processing a refund; you'll see it shortly.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "scenario-reply-thread-x",
        },
      },
      {
        type: "final_message",
        text: "Queued a heads-up, a refund recommendation, and the reply.",
      },
    ];

    const out = await driveCase(loopAgent(), script);

    // The loop did NOT stop at the first gated tool — all three were queued.
    expect(out.pending).toHaveLength(3);
    expect(new Set(out.pending.map((a) => a.tool))).toEqual(
      new Set(["merchant.notify", "refund.recommend", "conversation.reply"]),
    );
    for (const a of out.pending) {
      expect(a.status).toBe("pending");
      expect(a.caseId).toBe(out.fetched.id);
    }
    // End-of-loop: one bundle park, not three separate parks.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
  });

  it("resolves when an auto-permitted reply was sent and nothing was queued", async () => {
    const autoReplyAgent = loopAgent({
      permissionOverrides: { "conversation.reply": "allow" },
    });
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "r0",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "Thanks for reaching out — here is the info you asked for.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "scenario-reply-thread-x",
        },
      },
      { type: "final_message", text: "Replied to the customer." },
    ];

    const out = await driveCase(autoReplyAgent, script);

    expect(out.pending).toHaveLength(0);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
  });

  it("escalates to a human when the run produced no customer-facing action", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "n0",
        tool: "case.update_context",
        input: { notes: "looked into it but did nothing actionable" },
      },
      { type: "final_message", text: "Nothing to do." },
    ];

    const out = await driveCase(loopAgent(), script);

    expect(out.pending).toHaveLength(0);
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });
});

// ------------------------------------------------------------
// Slice 4d — one approve event executes the WHOLE queued bundle in order.
// ------------------------------------------------------------
type QueuedAction = { readonly tool: string; readonly input: unknown };

const seedAndResume = (actions: ReadonlyArray<QueuedAction>) => {
  const convo = makeConversationServiceTest({});
  const env = Layer.mergeAll(
    CaseRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([loopAgent()]),
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    LLMServiceScripted([]), // resume path never consults the LLM
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    convo.layer,
    approvalLinkLayer,
    platformMailNoop,
    tenantOverridesEmpty,
    tenantRepoDefault,
  );
  const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* CaseRepository;
        const approvals = yield* ApprovalService;

        const created = yield* repo.create({
          tenantId: TenantId(TENANT),
          channel: "email",
          currentAgentId: AgentId("scenario-resolution-agent"),
          subject: "Need help",
          threadId: "thread-x" as never,
          mailbox: "support@store.test",
        });
        // Park the case as if the autonomous loop had queued the bundle.
        yield* repo.transitionStatus(created.id, "in_progress", {
          tenantId: TenantId(TENANT),
          reason: "test setup",
        });
        yield* repo.transitionStatus(created.id, "waiting_for_approval", {
          tenantId: TenantId(TENANT),
          reason: "test setup: bundle queued",
        });

        // Create + approve every queued action, in order.
        const ids: string[] = [];
        for (const a of actions) {
          const approval = yield* approvals.create({
            tenantId: TenantId(TENANT),
            caseId: created.id,
            agentId: AgentId("scenario-resolution-agent"),
            tool: a.tool,
            proposedInput: a.input,
            reasoning: "queued by autonomous loop",
            riskLevel: "medium",
            expiresAt: new Date(Date.now() + 60_000),
          });
          ids.push(approval.id);
          yield* approvals.approve({
            id: approval.id,
            decidedBy: UserId("manager-1"),
            tenantId: TenantId(TENANT),
          });
        }

        // One approve event for the FIRST row drives the whole bundle.
        const result = yield* runtime.handleEvent({
          type: "approval.approved",
          approvalId: ids[0] as never,
          caseId: created.id,
          managerId: UserId("manager-1"),
        });

        const fetched = yield* repo.getById(created.id);
        return { result, fetched, ids };
      }),
      layer,
    ),
  ).then((r) => ({ ...r, sent: convo.handle.sent }));
};

const replyInput = (draftId: string, toEmail: string) => ({
  threadId: "thread-x",
  to: [{ name: null, email: toEmail }],
  subject: null,
  bodyText: `Reply ${draftId}.`,
  bodyHtml: null,
  inReplyToMessageId: null,
  draftId,
});

// ------------------------------------------------------------
// Slice 5 — the scenario envelope clamps the live agent's tools + permissions.
// ------------------------------------------------------------
const SCENARIO_KEY = "delivery_issue";

const driveScenarioCase = (
  resolutionPolicy: ResolutionPolicy,
  script: ReadonlyArray<LLMDecision>,
) => {
  const settings = new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    discountPolicy: defaultDiscountPolicy,
    retentionDays: 730,
    supplierEscalationSheet: null,
    legalAcceptance: null,
    resolutionPolicy,
  });
  const env = Layer.mergeAll(
    CaseRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([scenarioResolutionAgent]),
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    LLMServiceScripted(script),
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    ConversationServiceTest({}),
    approvalLinkLayer,
    platformMailNoop,
    tenantOverridesEmpty,
    TenantRepositoryTest({
      settingsByTenant: new Map([[TenantId(TENANT), settings]]),
    }),
  );
  const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* CaseRepository;
        const approvals = yield* ApprovalService;

        const created = yield* repo.create({
          tenantId: TenantId(TENANT),
          channel: "email",
          currentAgentId: scenarioResolutionAgent.id,
          subject: "Need help",
          mailbox: "support@store.test",
        });
        // Stamp the scenario triage would have picked.
        yield* repo.update(created.id, {
          context: { scenarioKey: SCENARIO_KEY } as never,
        });

        const result = yield* runtime.handleEvent({
          type: "customer.replied",
          caseId: created.id,
          payload: {
            threadId: "thread-x" as never,
            messageId: "msg-1",
            from: { name: null, email: "cust@example.com" },
            to: [],
            subject: "Re: Need help",
            bodyText: "My order arrived damaged.",
            bodyHtml: null,
            receivedAt: new Date(),
            attachments: [],
          },
        });

        const fetched = yield* repo.getById(created.id);
        const pending = yield* approvals.listPending(TenantId(TENANT));
        return { result, fetched, pending };
      }),
      layer,
    ),
  );
};

const refundCall = {
  type: "tool_call" as const,
  callId: "x0",
  tool: "refund.create",
  input: {
    orderId: "gid://shopify/Order/1001",
    amount: { amount: "10.00", currencyCode: "USD" },
    reason: "damaged on arrival",
  },
};

describe("scenario envelope (slice 5) — runtime clamps the live agent", () => {
  it("queues a remedy the scenario ENABLED (with its configured permission)", async () => {
    const policy: ResolutionPolicy = {
      scenarios: [
        {
          key: SCENARIO_KEY,
          label: "Delivery problem",
          builtin: true,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          supplierMode: "none",
          notes: "Offer a refund for damaged deliveries.",
        },
      ],
    };
    const out = await driveScenarioCase(policy, [
      refundCall,
      { type: "final_message", text: "Queued a refund for the damaged order." },
    ]);

    expect(out.pending.map((a) => a.tool)).toEqual(["refund.create"]);
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
  });

  it("denies (does not queue) a remedy the scenario did NOT enable", async () => {
    const policy: ResolutionPolicy = {
      scenarios: [
        {
          key: SCENARIO_KEY,
          label: "Delivery problem",
          builtin: true,
          enabledActions: [], // refunds NOT enabled for this scenario
          supplierMode: "none",
          notes: "Apologize but do not offer money.",
        },
      ],
    };
    const out = await driveScenarioCase(policy, [
      refundCall,
      { type: "final_message", text: "Nothing I can offer here." },
    ]);

    // refund.create was denied by the envelope → never queued → no action →
    // the case parks for a human.
    expect(out.pending).toHaveLength(0);
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
  });
});

describe("scenario-resolution autonomous loop — bundle resume (slice 4d)", () => {
  it("executes every approved action in order on a single approve event, then resolves", async () => {
    const out = await seedAndResume([
      { tool: "conversation.reply", input: replyInput("a", "cust@example.com") },
      { tool: "conversation.reply", input: replyInput("b", "cust@example.com") },
    ]);

    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    // Both queued replies ran, in proposal order.
    expect(out.sent.map((s) => (s.input as { draftId: string }).draftId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("stops the bundle on the first failure and parks the case for a human", async () => {
    // The FIRST action is addressed to the connected mailbox → a deterministic
    // recipient-guard reject; the second must NOT run.
    const out = await seedAndResume([
      { tool: "conversation.reply", input: replyInput("fail", "support@store.test") },
      { tool: "conversation.reply", input: replyInput("after", "cust@example.com") },
    ]);

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    // Neither send landed: the first was rejected before sending, the second
    // was never reached.
    expect(out.sent).toHaveLength(0);
  });
});
