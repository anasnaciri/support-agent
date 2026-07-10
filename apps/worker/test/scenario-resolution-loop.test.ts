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
import {
  orderStatusAgent,
  scenarioResolutionAgent,
  supportTriage,
} from "@support-agent/agents";
import type {
  MerchantNotification,
  ResolutionPolicy,
} from "@support-agent/services";
import {
  AgentResolverTest,
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
  ConversationServiceTest,
  decideApprovalBundle,
  LLMServiceScripted,
  makeConversationServiceTest,
  MerchantNotificationService,
  PlatformMailServiceTest,
  ShopifyServiceTest,
  SupplierEscalationServiceTest,
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
    "ticket.update_context",
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

const makeLayer = (
  agent: AgentConfig,
  script: ReadonlyArray<LLMDecision>,
  extras: ReadonlyArray<Layer.Layer<never, never, never>> = [],
) => {
  const env = Layer.mergeAll(
    TicketRepositoryTest,
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
    ...extras,
  );
  return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);
};

const driveTicket = (
  agent: AgentConfig,
  script: ReadonlyArray<LLMDecision>,
  extras: ReadonlyArray<Layer.Layer<never, never, never>> = [],
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
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
          ticketId: created.id,
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
        const entries = yield* audit.forTicket(created.id);
        return { result, fetched, pending, entries };
      }),
      makeLayer(agent, script, extras),
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

    const out = await driveTicket(loopAgent(), script);

    // The loop did NOT stop at the first gated tool — all three were queued.
    expect(out.pending).toHaveLength(3);
    expect(new Set(out.pending.map((a) => a.tool))).toEqual(
      new Set(["merchant.notify", "refund.recommend", "conversation.reply"]),
    );
    for (const a of out.pending) {
      expect(a.status).toBe("pending");
      expect(a.ticketId).toBe(out.fetched.id);
    }
    // End-of-loop: one bundle park, not three separate parks.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
  });

  it("pings the merchant ONCE with the queued actions and a bundle review link", async () => {
    const script: ReadonlyArray<LLMDecision> = [
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
      { type: "final_message", text: "Queued the refund and the reply." },
    ];

    const pings: MerchantNotification[] = [];
    const pingRecorder = Layer.succeed(MerchantNotificationService, {
      notify: (_tenantId, notification) => {
        pings.push(notification);
        return Effect.succeed({
          delivered: true,
          channel: "telegram" as const,
        });
      },
    });

    const out = await driveTicket(loopAgent(), script, [pingRecorder]);
    expect(out.fetched.status).toBe("waiting_for_approval");

    const approvalPings = pings.filter((p) => p.kind === "approval_requested");
    expect(approvalPings).toHaveLength(1);
    const ping = approvalPings[0]!;
    // The ping lists what was actually queued, not just a count.
    expect(ping.body).toContain("2 actions");
    expect(ping.body).toContain("Reply to the customer");
    expect(ping.body).toContain("We're processing a refund");
    // One signed review link on the API origin — the old ping pointed
    // `/tickets/:id` (a dashboard route) at the API host, a dead URL.
    expect(ping.body).toContain(
      `https://api.test.example/approvals/bundle/${out.fetched.id}?token=`,
    );
    expect(ping.body).not.toContain(`/tickets/${out.fetched.id}`);
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

    const out = await driveTicket(autoReplyAgent, script);

    expect(out.pending).toHaveLength(0);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
  });

  it("escalates to a human when the run produced no customer-facing action", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "n0",
        tool: "ticket.update_context",
        input: { notes: "looked into it but did nothing actionable" },
      },
      { type: "final_message", text: "Nothing to do." },
    ];

    const out = await driveTicket(loopAgent(), script);

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
    TicketRepositoryTest,
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
  const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;

        const created = yield* repo.create({
          tenantId: TenantId(TENANT),
          channel: "email",
          currentAgentId: AgentId("scenario-resolution-agent"),
          subject: "Need help",
          threadId: "thread-x" as never,
          mailbox: "support@store.test",
        });
        // Park the ticket as if the autonomous loop had queued the bundle.
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
            ticketId: created.id,
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
          ticketId: created.id,
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

const driveScenarioTicket = (
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
    TicketRepositoryTest,
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
  const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
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
          ticketId: created.id,
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
    const out = await driveScenarioTicket(policy, [
      refundCall,
      { type: "final_message", text: "Queued a refund for the damaged order." },
    ]);

    expect(out.pending.map((a) => a.tool)).toEqual(["refund.create"]);
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
  });

  it("keeps a remedy available even when the scenario didn't list it (tools on the agent, not clamped per scenario)", async () => {
    const policy: ResolutionPolicy = {
      scenarios: [
        {
          key: SCENARIO_KEY,
          label: "Delivery problem",
          builtin: true,
          // 2026-06-28: enabledActions is no longer applied at runtime — tools
          // are configured once on the agent. Per-scenario clamping is retained
          // (applyScenarioEnvelope) + tested but unwired.
          enabledActions: [],
          supplierMode: "none",
          notes: "Handle the delivery problem.",
        },
      ],
    };
    const out = await driveScenarioTicket(policy, [
      refundCall,
      { type: "final_message", text: "Queued a refund for the order." },
    ]);

    // No per-scenario clamp: refund.create is governed by the agent + refund
    // policy (ask), so it QUEUES instead of being denied — the ticket parks for
    // bundle approval rather than escalating to a human.
    expect(out.pending.map((a) => a.tool)).toEqual(["refund.create"]);
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
  });
});

// ------------------------------------------------------------
// The scenario agent is the entry point for EVERY tenant (2026-07-10). Inbound
// tickets are created bound to support-triage, and the runtime swaps them to the
// resolution agent unconditionally — no tenant flag, no triage classification
// hop. The legacy specialists are still registered and reachable by handoff;
// nothing routes to them on its own any more.
// ------------------------------------------------------------
const routingPolicy: ResolutionPolicy = {
  scenarios: [
    {
      key: "refund_request",
      label: "Refund request",
      recognition: "Customer wants their money back.",
      builtin: true,
      enabledActions: [{ tool: "refund.create", permission: "ask" }],
      supplierMode: "none",
      notes: "Check the order and the refund policy.",
    },
  ],
};

const driveWithSettings = (
  settings: TenantSettings,
  script: ReadonlyArray<LLMDecision>,
) => {
  const env = Layer.mergeAll(
    TicketRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([supportTriage, scenarioResolutionAgent, orderStatusAgent]),
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
  const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const approvals = yield* ApprovalService;

        const created = yield* repo.create({
          tenantId: TenantId(TENANT),
          channel: "email",
          currentAgentId: supportTriage.id,
          subject: "Refund please",
          mailbox: "support@store.test",
        });

        const result = yield* runtime.handleEvent({
          type: "customer.replied",
          ticketId: created.id,
          payload: {
            threadId: "thread-x" as never,
            messageId: "msg-1",
            from: { name: null, email: "cust@example.com" },
            to: [],
            subject: "Re: Refund please",
            bodyText: "I'd like a refund.",
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

/** The common case: a tenant with one saved scenario. */
const driveTriage = (script: ReadonlyArray<LLMDecision>) =>
  driveWithSettings(
    new TenantSettings({
      notificationEmail: null,
      refundPolicy: defaultRefundPolicy,
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 730,
      supplierEscalationSheet: null,
      legalAcceptance: null,
      resolutionPolicy: routingPolicy,
    }),
    script,
  );

describe("resolution-agent-direct entry (every tenant, no flag)", () => {
  it("runs the resolution agent directly (no triage), persisting the binding", async () => {
    const out = await driveTriage([
      // No triage hop: the resolution agent runs from turn 0 and picks the
      // scenario itself, then queues a gated reply and stops.
      {
        type: "tool_call",
        callId: "s0",
        tool: "ticket.update_context",
        input: {
          classification: "refund_request",
          scenarioKey: "refund_request",
          notes: "wants a refund",
        },
      },
      {
        type: "tool_call",
        callId: "s1",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "We're looking into your refund and will follow up.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "scenario-reply-thread-x",
        },
      },
      { type: "final_message", text: "Handled by the resolution agent." },
    ]);

    // The runtime swapped support-triage → the resolution agent and persisted it.
    expect(out.fetched.currentAgentId).toBe("scenario-resolution-agent");
    // The agent picked the scenario itself.
    expect(out.fetched.context["scenarioKey"]).toBe("refund_request");
    // The autonomous loop ran and queued the gated reply.
    expect(out.pending.map((a) => a.tool)).toEqual(["conversation.reply"]);
    expect(out.result.type).toBe("PausedWaitingForApproval");
  });

  it("routes a tenant that configured nothing at all, on the seeded built-in scenarios", async () => {
    // No resolutionPolicy in settings and no opt-in flag anywhere — the shape a
    // brand-new tenant has. It must still reach the resolution agent, on
    // `defaultResolutionPolicy`, rather than falling back to triage.
    const out = await driveWithSettings(
      new TenantSettings({
        notificationEmail: null,
        refundPolicy: defaultRefundPolicy,
        discountPolicy: defaultDiscountPolicy,
        retentionDays: 730,
        supplierEscalationSheet: null,
        legalAcceptance: null,
      }),
      [
        {
          type: "tool_call",
          callId: "s0",
          tool: "ticket.update_context",
          input: { scenarioKey: "refund_request", notes: "wants a refund" },
        },
        { type: "final_message", text: "Escalated." },
      ],
    );

    expect(out.fetched.currentAgentId).toBe("scenario-resolution-agent");
    // Nothing was sent to the customer, so the runtime parks it — but it parked
    // from the RESOLUTION agent, which is the point.
    expect(out.result.type).toBe("HumanTakeoverRequired");
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

  it("stops the bundle on the first failure and parks the ticket for a human", async () => {
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

// ------------------------------------------------------------
// SMOKE TEST — the whole feature, one chain, through the real runtime:
// inbound (flag ON) → resolution agent runs directly, picks the scenario,
// loops + queues a refund + a reply → bundle parks waiting_for_approval →
// operator approves the bundle (decideApprovalBundle, as the dashboard endpoint
// does) → runtime resumes → executes both queued actions in order → resolves.
// ------------------------------------------------------------
describe("SMOKE: resolution agent end-to-end (direct → queue → approve bundle → resolve)", () => {
  it("routes, queues a bundle, parks, and resolves after one bundle approval", async () => {
    const smokePolicy: ResolutionPolicy = {
      scenarios: [
        {
          key: "refund_request",
          label: "Refund request",
          recognition: "Customer wants their money back.",
          builtin: true,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          supplierMode: "none",
          notes: "Check the order, then refund and tell the customer.",
        },
      ],
    };
    const settings = new TenantSettings({
      notificationEmail: null,
      refundPolicy: defaultRefundPolicy,
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 730,
      supplierEscalationSheet: null,
      legalAcceptance: null,
      resolutionPolicy: smokePolicy,
    });

    const script: ReadonlyArray<LLMDecision> = [
      // — resolution agent, from turn 0 (no triage hop): pick the scenario,
      //   then queue a refund + the customer reply —
      {
        type: "tool_call",
        callId: "s-pick",
        tool: "ticket.update_context",
        input: {
          classification: "refund_request",
          scenarioKey: "refund_request",
          notes: "wants a refund for a damaged order",
        },
      },
      {
        type: "tool_call",
        callId: "s0",
        tool: "refund.create",
        input: {
          orderId: "gid://shopify/Order/1001",
          amount: { amount: "10.00", currencyCode: "USD" },
          reason: "refund for the reported issue",
        },
      },
      {
        type: "tool_call",
        callId: "s1",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "We're processing a refund for your order — you'll see it shortly.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "scenario-reply-thread-x",
        },
      },
      {
        type: "final_message",
        text: "Queued a refund and the customer reply for approval.",
      },
    ];

    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, scenarioResolutionAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}), // refundOrder synthesises a refund by default
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      TenantRepositoryTest({
        settingsByTenant: new Map([[TenantId(TENANT), settings]]),
      }),
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId(TENANT),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund please",
            mailbox: "support@store.test",
          });

          // TICK 1 — inbound customer message drives triage → scenario → queue.
          const tick1 = yield* runtime.handleEvent({
            type: "customer.replied",
            ticketId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: "I'd like a refund for my order.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const afterTick1 = yield* repo.getById(created.id);
          const pending = yield* approvals.listPending(TenantId(TENANT));

          // OPERATOR approves the whole bundle (what the dashboard endpoint does).
          const bundle = yield* decideApprovalBundle({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            action: "approve",
            managerId: UserId("manager-1"),
          });

          // TICK 2 — the single bundle event resumes the runtime.
          const tick2 = bundle.event
            ? yield* runtime.handleEvent(bundle.event)
            : null;
          const final = yield* repo.getById(created.id);

          return { tick1, afterTick1, pending, bundle, tick2, final };
        }),
        layer,
      ),
    );

    // The runtime ran the resolution agent directly, persisted the binding, and
    // the agent stamped the scenario it picked.
    expect(out.afterTick1.currentAgentId).toBe("scenario-resolution-agent");
    expect(out.afterTick1.context["scenarioKey"]).toBe("refund_request");
    // The autonomous loop queued BOTH actions and parked once.
    expect(out.tick1.type).toBe("PausedWaitingForApproval");
    expect(out.afterTick1.status).toBe("waiting_for_approval");
    expect(new Set(out.pending.map((a) => a.tool))).toEqual(
      new Set(["refund.create", "conversation.reply"]),
    );
    // One bundle approval decided both rows + emitted one event.
    expect(out.bundle.decidedCount).toBe(2);
    expect(out.bundle.event?.type).toBe("approval.approved");
    // The resume executed the bundle and resolved the ticket.
    expect(out.tick2?.type).toBe("Completed");
    expect(out.final.status).toBe("resolved");
  });
});

// ------------------------------------------------------------
// Per-action approval — a ticket with PENDING actions never resolves; an
// approved supplier escalation waits on the supplier (not resolution).
// ------------------------------------------------------------
const EXPIRES = new Date(Date.now() + 60_000);
const AGENT_ID = AgentId("scenario-resolution-agent");
const MGR = UserId("manager-1");

const partialLayer = (
  convo: ReturnType<typeof makeConversationServiceTest>,
  extra: ReadonlyArray<Layer.Layer<never, never, never>> = [],
) => {
  const env = Layer.mergeAll(
    TicketRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([loopAgent()]),
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    LLMServiceScripted([]),
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    convo.layer,
    approvalLinkLayer,
    platformMailNoop,
    tenantOverridesEmpty,
    tenantRepoDefault,
    ...extra,
  );
  return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);
};

const seedParkedTicket = (repo: typeof TicketRepository.Service, threadId = "thread-x") =>
  Effect.gen(function* () {
    const created = yield* repo.create({
      tenantId: TenantId(TENANT),
      channel: "email",
      currentAgentId: AGENT_ID,
      subject: "Need help",
      threadId: threadId as never,
      mailbox: "support@store.test",
    });
    yield* repo.transitionStatus(created.id, "in_progress", {
      tenantId: TenantId(TENANT),
      reason: "setup",
    });
    yield* repo.transitionStatus(created.id, "waiting_for_approval", {
      tenantId: TenantId(TENANT),
      reason: "setup: bundle queued",
    });
    return created;
  });

describe("per-action approval — no ticket with pending actions resolves", () => {
  it("executes an approved action but keeps the ticket parked while another is pending, then resolves once the last is approved", async () => {
    const convo = makeConversationServiceTest({});
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* seedParkedTicket(repo);
          const refund = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AGENT_ID,
            tool: "refund.create",
            proposedInput: {
              orderId: "gid://shopify/Order/1001",
              amount: { amount: "10.00", currencyCode: "USD" },
              reason: "approved item",
            },
            reasoning: "",
            riskLevel: "high",
            expiresAt: EXPIRES,
          });
          const reply = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AGENT_ID,
            tool: "conversation.reply",
            proposedInput: replyInput("a", "cust@example.com"),
            reasoning: "",
            riskLevel: "medium",
            expiresAt: EXPIRES,
          });

          // Approve ONLY the refund.
          yield* approvals.approve({
            id: refund.id,
            decidedBy: MGR,
            tenantId: TenantId(TENANT),
          });
          const r1 = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: refund.id as never,
            ticketId: created.id,
            managerId: MGR,
          });
          const afterFirst = yield* repo.getById(created.id);
          const pendingAfterFirst = yield* approvals.listPending(
            TenantId(TENANT),
          );
          const sentAfterFirst = convo.handle.sent.length;

          // Approve the reply too.
          yield* approvals.approve({
            id: reply.id,
            decidedBy: MGR,
            tenantId: TenantId(TENANT),
          });
          const r2 = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: reply.id as never,
            ticketId: created.id,
            managerId: MGR,
          });
          const final = yield* repo.getById(created.id);
          return {
            r1,
            afterFirst,
            pendingAfterFirst,
            sentAfterFirst,
            r2,
            final,
          };
        }),
        partialLayer(convo),
      ),
    );

    // Refund executed, but the ticket is NOT resolved — the reply still pends.
    expect(out.r1.type).toBe("PausedWaitingForApproval");
    expect(out.afterFirst.status).toBe("waiting_for_approval");
    expect(out.pendingAfterFirst.map((a) => a.tool)).toEqual([
      "conversation.reply",
    ]);
    expect(out.sentAfterFirst).toBe(0);
    // Approving the last pending action resolves the ticket + sends the reply.
    expect(out.r2.type).toBe("Completed");
    expect(out.final.status).toBe("resolved");
    expect(convo.handle.sent.map((s) => (s.input as { draftId: string }).draftId)).toEqual([
      "a",
    ]);
  });

  it("parks waiting_for_supplier (not resolved) when an approved action escalates to a supplier", async () => {
    const convo = makeConversationServiceTest({});
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* seedParkedTicket(repo);
          const esc = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AGENT_ID,
            tool: "supplier.escalate",
            proposedInput: { problem: "unit damaged in transit, please reship" },
            reasoning: "",
            riskLevel: "medium",
            expiresAt: EXPIRES,
          });
          yield* approvals.approve({
            id: esc.id,
            decidedBy: MGR,
            tenantId: TenantId(TENANT),
          });
          const result = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: esc.id as never,
            ticketId: created.id,
            managerId: MGR,
          });
          const final = yield* repo.getById(created.id);
          return { result, final };
        }),
        partialLayer(convo, [SupplierEscalationServiceTest({})]),
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForSupplier");
    expect(out.final.status).toBe("waiting_for_supplier");
  });

  // Concurrent waits, resume leg: the ticket still has an OPEN escalation (from a
  // PRIOR tick) while a reply approval was pending. Approving the last reply
  // must NOT resolve the ticket out from under the still-open supplier wait — the
  // row-derived `hasOpenEscalationForTicket` check parks it `waiting_for_supplier`
  // even though THIS bundle ran no escalate.
  it("parks waiting_for_supplier (not resolved) when the ticket still has an open escalation, even if the approved bundle ran no escalate", async () => {
    const convo = makeConversationServiceTest({});
    // Mutable: the fixture reads it at call-time, so we push the real (random)
    // ticket id in after seeding — the layer is built before the ticket exists.
    const openIds: string[] = [];
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* seedParkedTicket(repo);
          openIds.push(created.id as string);
          const reply = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AGENT_ID,
            tool: "conversation.reply",
            proposedInput: replyInput("draft-r", "cust@example.com"),
            reasoning: "",
            riskLevel: "medium",
            expiresAt: EXPIRES,
          });
          yield* approvals.approve({
            id: reply.id,
            decidedBy: MGR,
            tenantId: TenantId(TENANT),
          });
          const result = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: reply.id as never,
            ticketId: created.id,
            managerId: MGR,
          });
          const final = yield* repo.getById(created.id);
          return { result, final, sent: convo.handle.sent.length };
        }),
        partialLayer(convo, [
          SupplierEscalationServiceTest({ openEscalationTicketIds: openIds }),
        ]),
      ),
    );

    // The approved reply still sent...
    expect(out.sent).toBe(1);
    // ...but the ticket parks on the supplier, it does NOT resolve.
    expect(out.result.type).toBe("PausedWaitingForSupplier");
    expect(out.final.status).toBe("waiting_for_supplier");
  });

  // Back-compat: with the service present but NO open escalation for the ticket,
  // approving the last action resolves as before (row-derived, not blanket).
  it("resolves when the supplier service is present but the ticket has no open escalation", async () => {
    const convo = makeConversationServiceTest({});
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* seedParkedTicket(repo);
          const reply = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AGENT_ID,
            tool: "conversation.reply",
            proposedInput: replyInput("draft-r2", "cust@example.com"),
            reasoning: "",
            riskLevel: "medium",
            expiresAt: EXPIRES,
          });
          yield* approvals.approve({
            id: reply.id,
            decidedBy: MGR,
            tenantId: TenantId(TENANT),
          });
          const result = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: reply.id as never,
            ticketId: created.id,
            managerId: MGR,
          });
          const final = yield* repo.getById(created.id);
          return { result, final };
        }),
        partialLayer(convo, [SupplierEscalationServiceTest({})]),
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.final.status).toBe("resolved");
  });
});

// Concurrent wait states: a tick that QUEUES an ask-gated action and then
// escalates to the supplier holds BOTH waits. The bundle park must win
// (primaryWaitStatus precedence — the merchant is the next unblocker), or the
// queued approval is orphaned: no waiting_for_approval status, no approval
// email/ping, park guard 2.9 never fires, and a later dashboard approval
// would resolve the ticket out from under the open escalation.
describe("concurrent waits — escalate with a queued approval parks the bundle", () => {
  const escalatingLoopAgent = loopAgent({
    tools: ["conversation.reply", "supplier.escalate"],
    permissionOverrides: {
      "conversation.reply": "ask",
      "supplier.escalate": "allow",
    },
  });

  it("parks waiting_for_approval (not waiting_for_supplier) when a tick queues a reply then escalates", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "q0",
        tool: "conversation.reply",
        input: replyInput("draft-1", "cust@example.com"),
      },
      {
        type: "tool_call",
        callId: "q1",
        tool: "supplier.escalate",
        input: {
          problem: "Unit damaged in transit; replacement needed",
          orderRef: "#9001",
          shipCity: null,
          shipCountry: null,
          trackingNumber: null,
        },
      },
      { type: "final_message", text: "Escalated and drafted the reply." },
    ];

    const out = await driveTicket(escalatingLoopAgent, script, [
      SupplierEscalationServiceTest({}),
    ]);

    // The queued reply is NOT orphaned: the bundle park ran.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.tool).toBe("conversation.reply");
    // Bundle-park audit written (the approval email/ping path).
    expect(out.entries.map((e) => e.action)).toContain(
      "ticket.waiting_for_approval",
    );
    // The escalation itself still happened (tool invoked before the park).
    expect(
      out.entries.filter((e) => e.action === "tool.invoked"),
    ).not.toHaveLength(0);
  });

  it("still parks waiting_for_supplier when the tick escalated with nothing queued", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "q0",
        tool: "supplier.escalate",
        input: {
          problem: "Unit damaged in transit; replacement needed",
          orderRef: "#9002",
          shipCity: null,
          shipCountry: null,
          trackingNumber: null,
        },
      },
    ];

    const out = await driveTicket(escalatingLoopAgent, script, [
      SupplierEscalationServiceTest({}),
    ]);

    expect(out.result.type).toBe("PausedWaitingForSupplier");
    expect(out.fetched.status).toBe("waiting_for_supplier");
    expect(out.pending).toHaveLength(0);
  });
});

describe("re-engagement supersedes stale drafts", () => {
  it("cancels a leftover pending draft when the agent re-runs and drafts a fresh one", async () => {
    const convo = makeConversationServiceTest({});
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "conversation.reply",
        input: replyInput("fresh", "cust@example.com"),
      },
      { type: "final_message", text: "Drafted a fresh reply after re-engaging." },
    ];

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId(TENANT),
            channel: "email",
            currentAgentId: AgentId("scenario-resolution-agent"),
            subject: "Need help",
            threadId: "thread-x" as never,
            mailbox: "support@store.test",
          });
          // A draft left pending by a PRIOR run (the auto-escalate orphan).
          const stale = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AgentId("scenario-resolution-agent"),
            tool: "conversation.reply",
            proposedInput: replyInput("stale", "cust@example.com"),
            reasoning: "old draft, before the situation changed",
            riskLevel: "medium",
            expiresAt: EXPIRES,
          });

          // The agent re-engages and drafts a fresh reply.
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            ticketId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-2",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Need help",
              bodyText: "Any update?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const staleAfter = yield* approvals.getById(stale.id);
          const pending = yield* approvals.listPending(TenantId(TENANT));
          return { result, staleAfter, pending };
        }),
        makeLayer(loopAgent(), script),
      ),
    );

    // The old draft was superseded (cancelled), not left to pile up.
    expect(out.staleAfter.status).toBe("cancelled");
    // Only the fresh draft is awaiting approval.
    expect(
      out.pending.map((a) => (a.proposedInput as { draftId: string }).draftId),
    ).toEqual(["fresh"]);
    expect(out.result.type).toBe("PausedWaitingForApproval");
  });

  it("only supersedes stale DRAFTS — a pending refund is left untouched", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "conversation.reply",
        input: replyInput("fresh", "cust@example.com"),
      },
      { type: "final_message", text: "Drafted a reply." },
    ];

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const approvals = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId(TENANT),
            channel: "email",
            currentAgentId: AgentId("scenario-resolution-agent"),
            subject: "Need help",
            threadId: "thread-x" as never,
            mailbox: "support@store.test",
          });
          // A pending refund from a prior decision — NOT a draft.
          const refund = yield* approvals.create({
            tenantId: TenantId(TENANT),
            ticketId: created.id,
            agentId: AgentId("scenario-resolution-agent"),
            tool: "refund.create",
            proposedInput: {
              orderId: "gid://shopify/Order/1001",
              amount: { amount: "10.00", currencyCode: "USD" },
              reason: "x",
            },
            reasoning: "",
            riskLevel: "high",
            expiresAt: EXPIRES,
          });

          yield* runtime.handleEvent({
            type: "customer.replied",
            ticketId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-3",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Need help",
              bodyText: "Hi",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const refundAfter = yield* approvals.getById(refund.id);
          const pending = yield* approvals.listPending(TenantId(TENANT));
          return { refundAfter, pending };
        }),
        makeLayer(loopAgent(), script),
      ),
    );

    // The refund is NOT a draft → untouched; both it and the fresh draft pend.
    expect(out.refundAfter.status).toBe("pending");
    expect(new Set(out.pending.map((a) => a.tool))).toEqual(
      new Set(["refund.create", "conversation.reply"]),
    );
  });
});
