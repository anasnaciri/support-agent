import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type AgentConfig,
  type LLMDecision,
} from "@support-agent/agent-core";
import { ALL_TOOLS } from "@support-agent/tools";
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
  PlatformMailServiceTest,
  TenantAgentOverridesServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  TransactionRunnerPassthrough,
  ShopifyServiceTest,
  defaultRefundPolicy,
  defaultDiscountPolicy,
} from "@support-agent/services";

// Phase A: custom (merchant-authored) agents run through the AgentResolver.
// These tests drive the runtime with custom configs supplied to the resolver's
// Test layer (the projection/scaffold is exercised separately in
// packages/agents) and assert: a custom agent runs + is permission-gated, a
// built-in can hand off to a custom agent, and an unresolvable agent fails
// SAFE to human_takeover (not an infinite retry).

const TENANT = TenantId("tenant-acme");

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
  settingsByTenant: new Map([[TENANT, defaultTenantSettings]]),
});

const baseEnv = (
  resolver: ReturnType<typeof AgentResolverTest>,
  llm: ReturnType<typeof LLMServiceScripted>,
) =>
  Layer.mergeAll(
    CaseRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    resolver,
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    llm,
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    ConversationServiceTest({}),
    approvalLinkLayer,
    platformMailNoop,
    tenantOverridesEmpty,
    tenantRepoDefault,
  );

const withRuntime = (env: Layer.Layer<never, never, never> | ReturnType<typeof baseEnv>) =>
  Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

// A merchant-authored specialist that drafts a customer reply (gated to `ask`).
const customReturns: AgentConfig = {
  id: AgentId("custom:returns"),
  name: "Returns Concierge",
  description: "Handles returns.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: "You are a returns specialist.",
  tools: ["conversation.reply"],
  permissionOverrides: { "conversation.reply": "ask" },
  handoffs: [],
  maxTurnsPerTick: 3,
  temperature: 0,
};

describe("AgentRuntime — custom agents (Phase A)", () => {
  it("runs a custom agent and gates its reply through PermissionService", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "reply-0",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "Happy to help with your return — here's how.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "custom-returns-reply-1",
        },
      },
    ];
    const env = baseEnv(
      AgentResolverTest([], [{ tenantId: TENANT, config: customReturns }]),
      LLMServiceScripted(script),
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: customReturns.id,
            subject: "I want to return this",
            threadId: "thread-x" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: I want to return this",
              bodyText: "Can I send it back?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const pending = yield* approvalsSvc.listPending(TENANT);
          return { result, fetched, pending };
        }),
        withRuntime(env),
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
    // The case stayed on the custom agent.
    expect(out.fetched.currentAgentId).toBe(customReturns.id);
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.tool).toBe("conversation.reply");
    expect(out.pending[0]!.agentId).toBe(customReturns.id);
  });

  it("lets a built-in agent hand off to a custom agent (resolver swaps the active agent)", async () => {
    const router: AgentConfig = {
      id: AgentId("router-agent"),
      name: "Router",
      description: "Routes to a custom specialist.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "Hand off to the returns specialist.",
      tools: ["agent.handoff"],
      permissionOverrides: {},
      handoffs: [AgentId("custom:returns")],
      maxTurnsPerTick: 4,
      temperature: 0,
    };
    const customSpecialist: AgentConfig = {
      ...customReturns,
      tools: ["case.update_context"],
      permissionOverrides: {},
    };
    // turn0 (router): handoff → custom:returns; turn1 (custom, SAME tick):
    // update context; turn2: final_message. Sharing the tick budget across the
    // handoff is the existing invariant (covered for built-ins); here the point
    // is that the handoff TARGET resolves via the custom path.
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "h0",
        tool: "agent.handoff",
        input: { targetAgent: "custom:returns", reason: "returns" },
      },
      {
        type: "tool_call",
        callId: "u0",
        tool: "case.update_context",
        input: { notes: "handled by custom returns specialist" },
      },
      { type: "final_message", text: "All set." },
    ];
    const env = baseEnv(
      AgentResolverTest([router], [{ tenantId: TENANT, config: customSpecialist }]),
      LLMServiceScripted(script),
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: router.id,
            subject: "Return please",
            threadId: "thread-y" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-y" as never,
              messageId: "msg-2",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Return please",
              bodyText: "I'd like a return.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const actions = (yield* audit.forCase(created.id)).map((e) => e.action);
          return { result, fetched, actions };
        }),
        withRuntime(env),
      ),
    );

    expect(out.result.type).toBe("Completed");
    // The handoff persisted the custom agent onto the case row.
    expect(out.fetched.currentAgentId).toBe(AgentId("custom:returns"));
    // The custom agent actually ran a tool after the handoff.
    expect(out.fetched.context["notes"]).toBe(
      "handled by custom returns specialist",
    );
    expect(out.actions).toContain("tool.invoked");
  });

  it("fails SAFE to human_takeover when the case's agent no longer resolves", async () => {
    // No built-ins, no customs → the seeded `custom:gone` id resolves to null.
    const env = baseEnv(AgentResolverTest([], []), LLMServiceScripted([]));

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: AgentId("custom:gone"),
            subject: "Orphaned case",
            threadId: "thread-z" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-z" as never,
              messageId: "msg-3",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Orphaned case",
              bodyText: "Hello?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const actions = (yield* audit.forCase(created.id)).map((e) => e.action);
          return { result, fetched, actions };
        }),
        withRuntime(env),
      ),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    if (out.result.type === "HumanTakeoverRequired") {
      expect(out.result.reason).toBe("agent_unresolvable");
    }
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.actions).toContain("case.escalated_to_human");
  });

  // ---- Phase C: inbound routing via callableFrom (NOT static handoffs) ----
  const router: AgentConfig = {
    id: AgentId("router-agent"),
    name: "Router",
    description: "Routes inbound tickets.",
    mode: "primary",
    provider: "openrouter",
    model: "google/gemini-3.5-flash",
    promptTemplate: "Route the ticket to the right specialist.",
    tools: ["agent.handoff"],
    permissionOverrides: {},
    handoffs: [], // NO static targets — reachability comes from callableFrom
    maxTurnsPerTick: 4,
    temperature: 0,
  };
  const inboundSpecialist: AgentConfig = {
    ...customReturns,
    tools: ["case.update_context"],
    permissionOverrides: {},
  };

  const runRouter = async (callableFrom: ReadonlyArray<string>) => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "h0",
        tool: "agent.handoff",
        input: { targetAgent: "custom:returns", reason: "returns" },
      },
      {
        type: "tool_call",
        callId: "u0",
        tool: "case.update_context",
        input: { notes: "handled by inbound custom specialist" },
      },
      { type: "final_message", text: "done" },
    ];
    const env = baseEnv(
      AgentResolverTest([router], [
        {
          tenantId: TENANT,
          config: inboundSpecialist,
          callableFrom,
          whenToUse: "Use for returns.",
        },
      ]),
      LLMServiceScripted(script),
    );
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: router.id,
            subject: "Return",
            threadId: "thread-c" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-c" as never,
              messageId: "msg-c",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Return",
              bodyText: "Return please.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        withRuntime(env),
      ),
    );
  };

  it("allows a handoff to a custom agent that opted in via callableFrom", async () => {
    const out = await runRouter(["router-agent"]);
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.currentAgentId).toBe(AgentId("custom:returns"));
    expect(out.fetched.context["notes"]).toBe(
      "handled by inbound custom specialist",
    );
  });

  it("blocks a handoff to a custom agent that did NOT opt in", async () => {
    const out = await runRouter([]);
    // Handoff rejected → case stays on the router; the block is audited.
    expect(out.fetched.currentAgentId).toBe(AgentId("router-agent"));
    const handoffErrors = out.entries.filter(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as { error?: string } | null)?.error ===
          "target_not_in_handoffs",
    );
    expect(handoffErrors.length).toBe(1);
  });
});
