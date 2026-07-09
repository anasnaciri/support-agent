import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  PermissionServiceDefault,
  TenantId,
  ToolOutputInvalid,
  ToolRegistryWith,
  UserId,
  defineTool,
  type AgentConfig,
  type DomainEvent,
} from "@support-agent/agent-core";
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
  DEFAULT_RETENTION_DAYS,
  LLMServiceScripted,
  PlatformMailServiceTest,
  ProcessedMessageStoreTest,
  ShopifyServiceTest,
  TenantAgentOverridesServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  ToolExecutionStoreTest,
  TransactionRunnerPassthrough,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  makeReplyDeliveryServiceTest,
  AgentResolverTest,
} from "@support-agent/services";

// A failed customer-reply send must NEVER silently resolve the ticket, in either
// path:
//   - in-loop (auto): the error used to be fed back to the LLM, which could
//     emit final_message → resolved (the silent-delivery bug, Bug 2);
//   - approval-resume: the approved draft must be captured for retry, not just
//     escalated as a generic approved_tool_failed.
// Both now: enqueue the verbatim draft into the reply-delivery outbox, stamp the
// `reply_delivery_failed` flag, and park the ticket in human_takeover.

const tenantSettings = new TenantSettings({
  notificationEmail: null,
  refundPolicy: defaultRefundPolicy,
  discountPolicy: defaultDiscountPolicy,
  retentionDays: DEFAULT_RETENTION_DAYS,
  supplierEscalationSheet: null,
  legalAcceptance: null,
});

const tenantRepo = TenantRepositoryTest({
  settingsByTenant: new Map([[TenantId("tenant-acme"), tenantSettings]]),
});

const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
  baseUrl: "https://api.test.example",
  signingKey: "k",
  ttlMs: 60_000,
});

// A fake `conversation.reply` whose send always fails the way the real tool
// surfaces a transport error: ToolOutputInvalid wrapping the ConversationError
// _tag. The runtime keys off the tool NAME + this tag.
const failingReply = defineTool({
  name: "conversation.reply",
  description: "Test reply tool whose send always fails.",
  inputSchema: Schema.Struct({
    draftId: Schema.String,
    bodyText: Schema.String,
  }),
  outputSchema: Schema.Struct({ id: Schema.String }),
  risk: "communicate",
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  idempotencyKey: (input) => input.draftId,
  execute: () =>
    Effect.fail(
      new ToolOutputInvalid({
        tool: "conversation.reply",
        issues: ["ConversationSendFailed"],
      }),
    ),
});

const replyAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: AgentId("reply-test-agent"),
  promptTemplate: "Reply test agent.",
  model: "test/model",
  tools: ["conversation.reply"],
  handoffs: [],
  permissionOverrides: {},
  maxTurnsPerTick: 3,
  ...overrides,
});

const buildLayer = (
  llm: ReturnType<typeof LLMServiceScripted>,
  agents: ReadonlyArray<AgentConfig>,
  replyDeliveryFixtures: { readonly writeFailed?: boolean } = {},
) => {
  const replyDelivery = makeReplyDeliveryServiceTest(replyDeliveryFixtures);
  const env = Layer.mergeAll(
    TicketRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest(agents as never),
    ToolRegistryWith([failingReply] as never),
    PermissionServiceDefault,
    llm as never,
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    approvalLinkLayer,
    PlatformMailServiceTest({}),
    TenantAgentOverridesServiceTest(),
    tenantRepo,
    ProcessedMessageStoreTest,
    ToolExecutionStoreTest,
    replyDelivery.layer,
  );
  return {
    layer: Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env),
    handle: replyDelivery.handle,
  };
};

const customerReplied = (ticketId: string): DomainEvent => ({
  type: "customer.replied",
  ticketId: ticketId as never,
  payload: {
    threadId: "thread-1" as never,
    messageId: "msg-1",
    from: { name: null, email: "cust@example.com" },
    to: [],
    subject: "Help",
    bodyText: "Where is my order?",
    bodyHtml: null,
    receivedAt: new Date(),
    attachments: [],
  },
});

const runWithTicket = <A>(
  layer: Layer.Layer<never, never, never>,
  agentId: string,
  program: (ticketId: string) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TicketRepository;
        const created = yield* repo.create({
          tenantId: TenantId("tenant-acme"),
          channel: "email",
          currentAgentId: AgentId(agentId),
          subject: "Reply test",
          mailbox: "support@shop.com",
        });
        return yield* program(created.id);
      }),
      layer,
    ) as Effect.Effect<A, never, never>,
  );

describe("AgentRuntime — failed customer-reply delivery", () => {
  it("in-loop (auto): a failed reply does NOT resolve the ticket — parks + flags + enqueues", async () => {
    const { layer, handle } = buildLayer(
      LLMServiceScripted([
        {
          type: "tool_call",
          callId: "r0",
          tool: "conversation.reply",
          input: { draftId: "draft-A", bodyText: "On its way!" },
        },
        // If the runtime swallowed the send failure, the agent would resolve
        // here. It must never reach this.
        { type: "final_message", text: "All set!" },
      ]) as never,
      // Force the reply to run in-loop (tenant flipped it to auto).
      [replyAgent({ permissionOverrides: { "conversation.reply": "allow" } })],
    );

    const out = await runWithTicket(layer as never, "reply-test-agent", (ticketId) =>
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

    // Never resolved — parked needing attention.
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.status).not.toBe("resolved");
    // Flagged so the dashboard surfaces "delivery failed".
    expect(out.fetched.context["riskFlags"]).toContain("reply_delivery_failed");
    // The verbatim draft was captured for retry.
    expect(handle.enqueued).toHaveLength(1);
    expect(handle.enqueued[0]!.tool).toBe("conversation.reply");
    expect(handle.enqueued[0]!.draftId).toBe("draft-A");
    expect(handle.enqueued[0]!.mailbox).toBe("support@shop.com");
    expect(out.entries.map((e) => e.action)).toContain(
      "ticket.escalated_to_human",
    );
    // The failed tool.invoked row now carries the reason (not just ok:false),
    // so a send failure is debuggable from the audit log alone.
    const toolInvoked = out.entries.find(
      (e) => e.action === "tool.invoked" && e.details["ok"] === false,
    );
    expect(toolInvoked?.details["error"]).toBe("ConversationSendFailed");
  });

  it("does not park the ticket when the retryable reply draft cannot be captured", async () => {
    const { layer, handle } = buildLayer(
      LLMServiceScripted([
        {
          type: "tool_call",
          callId: "r0",
          tool: "conversation.reply",
          input: { draftId: "draft-lost", bodyText: "Please do not lose me" },
        },
      ]) as never,
      [replyAgent({ permissionOverrides: { "conversation.reply": "allow" } })],
      { writeFailed: true },
    );

    const out = await runWithTicket(layer as never, "reply-test-agent", (ticketId) =>
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

    expect(out.result.type).toBe("Failed");
    if (out.result.type === "Failed") {
      expect(out.result.retryable).toBe(true);
    }
    expect(out.fetched.status).toBe("new");
    expect(out.fetched.context["riskFlags"] ?? []).not.toContain(
      "reply_delivery_failed",
    );
    expect(handle.enqueued).toHaveLength(0);
    expect(out.entries.map((e) => e.action)).not.toContain(
      "ticket.escalated_to_human",
    );
  });

  it("approval-resume: a failed approved reply captures the draft + flags reply_delivery_failed", async () => {
    const { layer, handle } = buildLayer(
      LLMServiceScripted([]) as never,
      [replyAgent()],
    );

    const out = await runWithTicket(layer as never, "reply-test-agent", (ticketId) =>
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const audit = yield* AuditLogService;
        const approvals = yield* ApprovalService;
        const approval = yield* approvals.create({
          tenantId: TenantId("tenant-acme"),
          ticketId: ticketId as never,
          agentId: AgentId("reply-test-agent"),
          tool: "conversation.reply",
          proposedInput: { draftId: "draft-B", bodyText: "Approved reply" },
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
        const entries = yield* audit.forTicket(ticketId as never);
        return { result, fetched, entries };
      }),
    );

    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.context["riskFlags"]).toContain("reply_delivery_failed");
    expect(handle.enqueued).toHaveLength(1);
    expect(handle.enqueued[0]!.draftId).toBe("draft-B");
    // Escalation reason reflects the delivery failure, not generic tool failure.
    const escalation = out.entries.find(
      (e) => e.action === "ticket.escalated_to_human",
    );
    expect(escalation?.details["reason"]).toBe("reply_delivery_failed");
  });
});
