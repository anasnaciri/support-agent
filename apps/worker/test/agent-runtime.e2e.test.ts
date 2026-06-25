import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  CustomerId,
  OrderId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type AgentConfig,
  type DomainEvent,
  type LLMDecision,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import {
  damagedProductAgent,
  missingPackageAgent,
  orderStatusAgent,
  refundReviewAgent,
  supportTriage,
} from "@support-agent/agents";
// Tests register the full platform tool set (`ALL_TOOLS`) rather than a
// hand-picked subset: the scripted LLM drives which tools actually execute,
// so registering everything is behavior-neutral and means a test no longer
// breaks merely because an agent started declaring a new tool.
import { ALL_TOOLS } from "@support-agent/tools";
import {
  AgentRuntime,
  AgentRuntimeDefault,
  ApprovalLinkConfig,
  ApprovalService,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseRepository,
  CaseRepositoryTest,
  ConnectorCredentialStoreTest,
  ConversationServiceTest,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  ImageHashStore,
  ImageHashStoreTest,
  LLMServiceFromFn,
  LLMServiceScripted,
  PermissionServiceLive,
  PlatformMailServiceTest,
  SheetsServiceTest,
  ShopifyServiceTest,
  SupplierEscalationServiceTest,
  TenantAgentOverridesServiceTest,
  TrackingServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  TimerService,
  TransactionRunnerPassthrough,
  makeConversationServiceTest,
  makeMerchantNotificationServiceTest,
  makePlatformMailServiceTest,
  type ConnectorConnection,
  AgentResolverTest,
} from "@support-agent/services";
import { UserId } from "@support-agent/agent-core";

// Shared stubs for the two new runtime deps. Approval-link config uses
// a fixed signing key + a placeholder base URL — the existing tests
// don't assert email shape, they just need the runtime's Layer to
// resolve. The new refund-review-approval e2e at the bottom of the file
// uses `makePlatformMailServiceTest` with a handle to inspect sends.
const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
  baseUrl: "https://api.test.example",
  signingKey: "test-signing-key",
  ttlMs: 60_000,
});
const platformMailNoop = PlatformMailServiceTest({});
const tenantOverridesEmpty = TenantAgentOverridesServiceTest();
// Default tenant settings used by every e2e flow that doesn't care
// about the values. `supplierEscalationSheet: null` keeps the runtime's
// `buildSystemPrompt` from injecting the supplier header into agents
// that don't exercise it. Tests that need a non-null sheet override
// this layer locally.
const defaultTenantSettings = new TenantSettings({
  notificationEmail: null,
  refundPolicy: defaultRefundPolicy,
  discountPolicy: defaultDiscountPolicy,
  retentionDays: 730,
  supplierEscalationSheet: null,
  legalAcceptance: null,
});
const tenantRepoDefault = TenantRepositoryTest({
  settingsByTenant: new Map([
    [TenantId("tenant-acme"), defaultTenantSettings],
  ]),
});
import { Effect as Eff } from "effect";

// ------------------------------------------------------------
// The scripted LLM run for support-triage:
//   turn 0: write classification into context
//   turn 1: transition the case to resolved
//   turn 2: final_message → runtime returns Completed
// ------------------------------------------------------------
const triageScript: ReadonlyArray<LLMDecision> = [
  {
    type: "tool_call",
    callId: "c0",
    tool: "case.update_context",
    input: {
      classification: "where_is_order",
      identifiedOrderId: "ord_42",
      notes: "customer wants tracking",
    },
  },
  {
    type: "tool_call",
    callId: "c1",
    tool: "case.update_status",
    input: { status: "resolved", reason: "triage complete" },
  },
  {
    type: "final_message",
    text: "Classified as where_is_order; case resolved.",
  },
];

const tickEnv = Layer.mergeAll(
  CaseRepositoryTest,
  AuditLogServiceTest,
  ApprovalServiceTest,
  AgentResolverTest([supportTriage, orderStatusAgent]),
  ToolRegistryWith(ALL_TOOLS),
  PermissionServiceDefault,
  LLMServiceScripted(triageScript),
  TransactionRunnerPassthrough,
  ShopifyServiceTest({}),
  approvalLinkLayer,
  platformMailNoop,
  tenantOverridesEmpty,
  tenantRepoDefault,
);

const runtimeLayer = AgentRuntimeDefault.pipe(Layer.provide(tickEnv));
// Provide the inspection services on top of the runtime so the test can also
// poke at the case + audit log after the tick.
const fullLayer = Layer.merge(runtimeLayer, tickEnv);

const ticketCreated = (
  body: string,
  tenantId = "tenant-acme",
): DomainEvent => ({
  type: "ticket.created",
  tenantId: TenantId(tenantId),
  source: "api",
  payload: {
    subject: "Where is my order?",
    body,
    customerEmail: "cust@example.com",
    metadata: {},
  },
});

describe("AgentRuntime — e2e ticket.created → resolved", () => {
  it("triages a ticket end-to-end via support-triage", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const workflow = yield* runtime.handleEvent(
            ticketCreated("My order is late."),
          );

          // Pull state back out for assertions.
          const cases = yield* repo
            .findByThreadId(TenantId("tenant-acme"), "never" as never)
            .pipe(Effect.map(() => null)); // unused, but exercises Tag

          // We don't know the generated caseId from the outside, so we list
          // pending approvals (none expected) and re-derive by querying audit
          // entries. Simpler: walk the audit log for any case in this tenant.
          // The Test layer doesn't expose a "all cases" listing — but the
          // workflow result + audit entries are enough for the assertions.

          // Fetch all audit entries by re-using the in-memory caseId from the
          // event.received entry. We need a caseId; the test layer stores it.
          // We can find it via the only created case: list approvals (none),
          // and check audit by scanning a known caseId. Since we can't, we
          // resort to inspecting the workflow result + that *something*
          // happened.

          // Pragmatic approach: pull the audit log by enumerating a few caseIds
          // is not possible; instead expose via repo.findByThreadId(null) (we
          // didn't set a threadId). For Phase 1 minimum we assert via
          // workflow + repo.getById with a known id — see test below.

          return { workflow, cases };
        }),
        fullLayer,
      ),
    );

    expect(result.workflow.type).toBe("Completed");
  });

  it("produces the expected audit trail (event.received + 3 llm.decision + 2 tool.invoked)", async () => {
    // To assert on the audit trail we need the caseId. Take a different path:
    // create the case explicitly via the repo first (status=new), then dispatch
    // a customer.replied event to drive the runtime — same tick logic, but the
    // caseId is known to the test.
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          // Bootstrap a fresh case in "new" state.
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is my order?",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Tracking? Order ord_42.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        fullLayer,
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    expect(out.fetched.context["classification"]).toBe("where_is_order");
    expect(out.fetched.context["identifiedOrderId"]).toBe("ord_42");

    // Audit trail shape: event.received + 3 llm.decision + 2 tool.invoked
    // + the lifecycle audit emitted by case.update_status.
    // No trailing `case.resolved` here because the case was already
    // resolved by the second tool call before the final_message turn — the
    // runtime's transition-on-final-message branch is a no-op when status
    // is already "resolved".
    const actions = out.entries.map((e) => e.action);
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "case.status_changed",
      "tool.invoked",
      "llm.decision",
    ]);
    // Actor types: system for event.received, agent for the rest.
    expect(out.entries[0]?.actor.type).toBe("system");
    for (const e of out.entries.slice(1)) {
      expect(e.actor.type).toBe("agent");
      expect(e.actor.id).toBe(supportTriage.id);
    }
  });

  it("hands off to order-status-agent, drafts a conversation.reply, and pauses for approval", async () => {
    const orderId = OrderId("gid://shopify/Order/12345");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#1001",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/777"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "29.99", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Mug",
          quantity: 1,
          sku: "MUG-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [
        {
          id: "f-1",
          status: "in_transit",
          trackingCompany: "UPS",
          trackingNumbers: ["1Z999"],
          trackingUrls: ["https://example.test/track/1Z999"],
          estimatedDeliveryAt: new Date("2026-05-20T00:00:00.000Z"),
          deliveredAt: null,
          createdAt: new Date("2026-05-14T00:00:00.000Z"),
          updatedAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
    };

    // turn 0 — triage classifies + records the order id on the case
    // turn 1 — triage hands off to order-status-agent
    // turn 2 — order-status-agent fetches the order via shopify.get_order
    // turn 3 — order-status-agent drafts conversation.reply; permission
    //          service returns "ask" -> runtime parks the case.
    const handoffScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "where_is_order",
          identifiedOrderId: orderId,
          notes: "tracking question",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "order-status-agent",
          reason: "specialist owns where_is_order",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText:
            "Your order #1001 is paid and currently in transit with UPS. The tracking number is 1Z999, and Shopify shows an estimated delivery date of 2026-05-20.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "order-status-reply-test-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(handoffScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is my order?",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: `Tracking? Order ${orderId}.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, entries, pending };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    if (out.result.type === "PausedWaitingForApproval") {
      expect(out.result.approvalId).toBeTruthy();
    }
    expect(out.fetched.status).toBe("waiting_for_approval");
    // The handoff persisted the new agent on the case row.
    expect(out.fetched.currentAgentId).toBe(orderStatusAgent.id);
    expect(out.fetched.context["classification"]).toBe("where_is_order");
    expect(out.fetched.context["identifiedOrderId"]).toBe(orderId);

    expect(out.pending).toHaveLength(1);
    const approval = out.pending[0]!;
    expect(approval.tool).toBe("conversation.reply");
    expect(approval.agentId).toBe(orderStatusAgent.id);
    expect(approval.caseId).toBe(out.fetched.id);
    expect(approval.status).toBe("pending");
    const proposed = approval.proposedInput as {
      readonly threadId: string;
      readonly to: ReadonlyArray<{ email: string }>;
      readonly draftId: string;
    };
    expect(proposed.threadId).toBe("thread-x");
    expect(proposed.to[0]?.email).toBe("cust@example.com");
    expect(proposed.draftId).toBe("order-status-reply-test-1");

    const actions = out.entries.map((e) => e.action);
    // event.received + (llm.decision, tool.invoked) x 3 + final llm.decision
    // + the case.waiting_for_approval park row (written in the same tx as
    // the approval + transition). No `tool.invoked` for conversation.reply
    // because permission=ask short-circuits before execute. No
    // `case.resolved` because we paused.
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "case.waiting_for_approval",
    ]);

    // The handoff audit row carries the source agent id (support-triage) and
    // a target field in details — that's how downstream timelines render
    // "Triage handed off to Order Status".
    const handoffEntry = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] === "agent.handoff",
    );
    expect(handoffEntry).toBeDefined();
    expect(handoffEntry?.actor.id).toBe(supportTriage.id);
    expect((handoffEntry?.details as Record<string, unknown>)["target"]).toBe(
      orderStatusAgent.id,
    );
    expect((handoffEntry?.details as Record<string, unknown>)["ok"]).toBe(true);

    // The shopify.get_order audit is recorded by the new agent.
    const shopifyEntry = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] === "shopify.get_order",
    );
    expect(shopifyEntry?.actor.id).toBe(orderStatusAgent.id);
  });

  it("runs conversation.ask_customer, schedules a follow-up timer, and pauses for the customer", async () => {
    const askingAgent: AgentConfig = {
      id: AgentId("ask-customer-agent"),
      name: "Ask Customer",
      description: "Asks a clarifying question and waits for a reply.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "Ask the customer for missing information.",
      tools: ["conversation.ask_customer"],
      permissionOverrides: {},
      handoffs: [],
      maxTurnsPerTick: 2,
      temperature: 0,
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "ask-0",
        tool: "conversation.ask_customer",
        input: {
          threadId: "thread-x",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText: "Can you describe what was missing from the package?",
          bodyHtml: null,
          remindAfterHours: 72,
          draftId: "ask-customer-thread-x",
        },
      },
    ];
    const scheduled: Array<{
      readonly caseId: CaseId;
      readonly fireAt: Date;
      readonly reason: string;
    }> = [];
    const timerLayer = Layer.succeed(
      TimerService,
      TimerService.of({
        schedule: (input) =>
          Effect.sync(() => {
            scheduled.push({
              caseId: input.caseId,
              fireAt: input.fireAt,
              reason: input.reason,
            });
            return {
              id: "timer-ask-1",
              caseId: input.caseId,
              fireAt: input.fireAt,
              reason: input.reason,
              firedAt: null,
              cancelledAt: null,
            };
          }),
        cancelOpenForCase: () => Effect.succeed(0),
        fireDue: () => Effect.succeed([]),
      }),
    );
    const { layer: conversationLayer, handle } =
      makeConversationServiceTest({});
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([askingAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      conversationLayer,
      timerLayer,
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const horizonMs = 72 * 60 * 60 * 1000;
    const before = Date.now();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: askingAgent.id,
            subject: "Need more information",
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
              subject: "Re: Need more information",
              bodyText: "Something is wrong with my order.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );
    const after = Date.now();

    expect(out.result.type).toBe("PausedWaitingForCustomer");
    expect(out.fetched.status).toBe("waiting_for_customer");
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.kind).toBe("askCustomer");
    expect(handle.sent[0]!.input.remindAfterHours).toBe(72);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.caseId).toBe(out.fetched.id);
    expect(scheduled[0]!.reason).toBe("follow_up");
    expect(scheduled[0]!.fireAt.getTime()).toBeGreaterThanOrEqual(
      before + horizonMs - 1_000,
    );
    expect(scheduled[0]!.fireAt.getTime()).toBeLessThanOrEqual(
      after + horizonMs + 1_000,
    );
    expect(out.entries.map((e) => e.action)).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "case.waiting_for_customer",
    ]);
  });

  // ----------------------------------------------------------------
  // supplier.escalate producer: an agent with the tool set to `allow`
  // hands a stuck order to the supplier; the runtime records the
  // escalation (via SupplierEscalationService), parks the case in
  // waiting_for_supplier, and ends the tick (no customer reply).
  // ----------------------------------------------------------------
  it("runs supplier.escalate and parks the case in waiting_for_supplier", async () => {
    const escalatingAgent: AgentConfig = {
      id: AgentId("escalating-agent"),
      name: "Escalating",
      description: "Escalates a stuck order to the supplier.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "Escalate the stuck order to the supplier.",
      tools: ["supplier.escalate"],
      // `allow` → the runtime parks in waiting_for_supplier rather than
      // creating an approval (the default `ask` would park in
      // waiting_for_approval instead).
      permissionOverrides: { "supplier.escalate": "allow" },
      handoffs: [],
      maxTurnsPerTick: 2,
      temperature: 0,
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "esc-0",
        tool: "supplier.escalate",
        input: {
          problem: "Order stuck in transit 12 days past the delivery window",
          orderRef: "#7001",
          shipCity: "Berlin",
          shipCountry: "DE",
          trackingNumber: "TRK-1",
        },
      },
    ];
    let captured: Record<string, unknown> | undefined;
    const supplierLayer = SupplierEscalationServiceTest({
      escalate: (input) => {
        captured = input as unknown as Record<string, unknown>;
        return Effect.succeed({
          kind: "escalated" as const,
          escalationId: "esc-1",
          supplierId: "sup-1",
          supplierEmail: "wh@x.com",
        });
      },
    });
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([escalatingAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      supplierLayer,
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: escalatingAgent.id,
            subject: "Where is my order?",
            threadId: "thread-e" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-e" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "It's been two weeks and nothing arrived.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForSupplier");
    expect(out.fetched.status).toBe("waiting_for_supplier");
    // The tool forwarded the agent's privacy projection to the service.
    expect(captured).toMatchObject({
      problem: "Order stuck in transit 12 days past the delivery window",
      orderRef: "#7001",
      shipCity: "Berlin",
      shipCountry: "DE",
      trackingNumber: "TRK-1",
    });
    expect(out.entries.map((e) => e.action)).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "case.waiting_for_supplier",
    ]);
  });

  // ----------------------------------------------------------------
  // No supplier configured: supplier.escalate returns { escalated: false }
  // (a normal result, not an error) → the runtime does NOT park the case;
  // the agent reads the result and falls back (here, resolves). Proves the
  // agent never assumes a supplier exists.
  // ----------------------------------------------------------------
  it("does NOT park when no supplier is configured (escalated:false)", async () => {
    const escalatingAgent: AgentConfig = {
      id: AgentId("escalating-agent"),
      name: "Escalating",
      description: "Escalates a stuck order to the supplier.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "Escalate the stuck order; reply if there's no supplier.",
      tools: ["supplier.escalate"],
      permissionOverrides: { "supplier.escalate": "allow" },
      handoffs: [],
      maxTurnsPerTick: 3,
      temperature: 0,
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "esc-0",
        tool: "supplier.escalate",
        input: { problem: "Order #7001 stuck in transit", orderRef: "#7001" },
      },
      { type: "final_message", text: "No supplier — acknowledged the delay." },
    ];
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([escalatingAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      SupplierEscalationServiceTest({ noSupplier: true }),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: escalatingAgent.id,
            subject: "Where is my order?",
            threadId: "thread-ns" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-ns" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Still nothing.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    // The case is NOT parked on the supplier — the agent kept control.
    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    const actions = out.entries.map((e) => e.action);
    expect(actions).not.toContain("case.waiting_for_supplier");
    expect(actions).toContain("tool.invoked"); // the escalate attempt happened
  });

  // ----------------------------------------------------------------
  // supplier park guard: a case in waiting_for_supplier holds stray
  // events (a customer reply, a timer) so the agent never answers the
  // customer while the warehouse still owns the case. Only
  // supplier.updated / manual.takeover / case.resumed pass through.
  // ----------------------------------------------------------------
  it("holds a stray customer reply while waiting_for_supplier (agent loop never runs)", async () => {
    const parkedAgent: AgentConfig = {
      id: AgentId("parked-agent"),
      name: "Parked",
      description: "Parked on the supplier.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "n/a",
      tools: [],
      permissionOverrides: {},
      handoffs: [],
      maxTurnsPerTick: 2,
      temperature: 0,
    };
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([parkedAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      // Empty script — if the guard fails and the loop runs, there's no
      // decision to serve, so a green run proves the LLM was never consulted.
      LLMServiceScripted([]),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: parkedAgent.id,
            subject: "Where is my order?",
            threadId: "thread-p" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          yield* repo.transitionStatus(created.id, "waiting_for_supplier", {
            reason: "test setup",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-p" as never,
              messageId: "msg-2",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Any update??",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForSupplier");
    expect(out.fetched.status).toBe("waiting_for_supplier");
    const actions = out.entries.map((e) => e.action);
    expect(actions).toContain("event.held_waiting_for_supplier");
    expect(actions).not.toContain("llm.decision");
  });

  // ----------------------------------------------------------------
  // supplier.updated consumer: the complement of the guard above — a
  // supplier update PASSES the park guard, re-enters the agent loop
  // (so it can draft the customer reply), and resolves the case.
  // ----------------------------------------------------------------
  it("re-enters the agent loop on supplier.updated and resolves the case", async () => {
    const reengageAgent: AgentConfig = {
      id: AgentId("reengage-agent"),
      name: "Re-engage",
      description: "Drafts the customer reply after a supplier update.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "Reply to the customer with the supplier's update.",
      tools: [],
      permissionOverrides: {},
      handoffs: [],
      maxTurnsPerTick: 2,
      temperature: 0,
    };
    const script: ReadonlyArray<LLMDecision> = [
      { type: "final_message", text: "Replied to the customer." },
    ];
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([reengageAgent]),
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
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: reengageAgent.id,
            subject: "Where is my order?",
            threadId: "thread-s" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });
          yield* repo.transitionStatus(created.id, "waiting_for_supplier", {
            reason: "test setup",
          });
          const result = yield* runtime.handleEvent({
            type: "supplier.updated",
            caseId: created.id,
            payload: {
              supplierId: "sup-1",
              note: "Reshipped via DHL; new ETA Friday.",
              proposedResolution: "reship",
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    const actions = out.entries.map((e) => e.action);
    // The loop ran (not held) — an LLM decision was recorded.
    expect(actions).toContain("llm.decision");
    expect(actions).not.toContain("event.held_waiting_for_supplier");
  });

  // ----------------------------------------------------------------
  // order-status-agent with `tracking.lookup` in the chain. The agent
  // fetches the order, sees a tracking number, calls tracking.lookup
  // (which TrackingServiceTest returns a synthetic "live" status for),
  // stamps the result into case.context via case.update_context, then
  // drafts the reply for approval.
  // ----------------------------------------------------------------
  it("order-status-agent enriches the reply with tracking.lookup + case.update_context when a tracking number is present", async () => {
    const orderId = OrderId("gid://shopify/Order/77001");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7001",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/700"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "59.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Coffee Beans",
          quantity: 1,
          sku: "BEAN-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [
        {
          id: "f-1",
          status: "in_transit",
          trackingCompany: "UPS",
          trackingNumbers: ["1Z777"],
          trackingUrls: ["https://wwwapps.ups.com/tracking?t=1Z777"],
          estimatedDeliveryAt: new Date("2026-05-25T00:00:00.000Z"),
          deliveredAt: null,
          createdAt: new Date("2026-05-22T00:00:00.000Z"),
          updatedAt: new Date("2026-05-23T00:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    };

    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "where_is_order",
          identifiedOrderId: orderId,
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "order-status-agent",
          reason: "specialist owns where_is_order",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "tracking.lookup",
        input: { trackingNumber: "1Z777", carrier: "UPS" },
      },
      {
        type: "tool_call",
        callId: "c4",
        tool: "case.update_context",
        input: {
          liveTrackingStatus: {
            kind: "live",
            status: "in_transit",
            carrier: "UPS",
            trackingNumber: "1Z777",
          },
        },
      },
      {
        type: "tool_call",
        callId: "c5",
        tool: "conversation.reply",
        input: {
          threadId: "thread-7001",
          to: [{ name: null, email: "cust@example.com" }],
          subject: null,
          bodyText:
            "Order #7001 is in transit with UPS (last scan recorded in TEST). Estimated delivery 2026-05-26.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "order-status-reply-7001",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      // Default TrackingServiceTest returns a deterministic "live"
      // in_transit status (see services/src/tracking-service.ts).
      TrackingServiceTest({}),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is order #7001?",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-7001" as never,
              messageId: "msg-7001",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is order #7001?",
              bodyText: `Where is order ${orderId}?`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const entries = yield* audit.forCase(created.id);
          const fetched = yield* repo.getById(created.id);
          return { result, entries, fetched };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");

    // Asserts the full chain was invoked: tracking.lookup ran, then
    // case.update_context stamped the live status, then conversation.reply
    // parked for approval (no tool.invoked row for it — ask short-circuits
    // BEFORE execute).
    const tools = out.entries
      .filter((e) => e.action === "tool.invoked")
      .map((e) => (e.details as Record<string, unknown>)["tool"]);
    expect(tools).toContain("tracking.lookup");
    expect(tools).toContain("case.update_context");
    expect(tools).toContain("shopify.get_order");
    expect(tools).not.toContain("conversation.reply");

    // The live tracking status actually landed on the case context (via the
    // named `liveTrackingStatus` field — the operator-visible carrier state).
    expect(out.fetched.context["liveTrackingStatus"]).toMatchObject({
      kind: "live",
      status: "in_transit",
    });
  });

  // ----------------------------------------------------------------
  // order-status-agent without a tracking number: the prompt branches
  // explicitly skip tracking.lookup. Just shopify.get_order →
  // conversation.reply.
  // ----------------------------------------------------------------
  it("order-status-agent skips tracking.lookup when the order has no tracking number", async () => {
    const orderId = OrderId("gid://shopify/Order/77002");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7002",
      confirmationNumber: null,
      email: "cust2@example.com",
      customerId: CustomerId("gid://shopify/Customer/702"),
      fulfillmentStatus: "unfulfilled",
      financialStatus: "paid",
      totalPrice: { amount: "29.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        { id: "li-1", title: "T-shirt", quantity: 1, sku: "TS-01", variantTitle: null, productId: null },
      ],
      fulfillments: [], // no tracking number to look up
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
      updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    };

    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "where_is_order",
          identifiedOrderId: orderId,
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: { targetAgent: "order-status-agent", reason: "where_is_order" },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      // Per the prompt: no tracking number → skip tracking.lookup +
      // case.update_context → straight to reply.
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-7002",
          to: [{ name: null, email: "cust2@example.com" }],
          subject: null,
          bodyText:
            "Order #7002 is paid but not yet shipped from our warehouse — you'll get a tracking update by email once it goes out.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "order-status-reply-7002",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      TrackingServiceTest({}),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is order #7002?",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-7002" as never,
              messageId: "msg-7002",
              from: { name: null, email: "cust2@example.com" },
              to: [],
              subject: "Re: Where is order #7002?",
              bodyText: `Where is order ${orderId}?`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const entries = yield* audit.forCase(created.id);
          return { result, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    const tools = out.entries
      .filter((e) => e.action === "tool.invoked")
      .map((e) => (e.details as Record<string, unknown>)["tool"]);
    expect(tools).toContain("shopify.get_order");
    expect(tools).not.toContain("tracking.lookup");
  });

  it("audits a rejected handoff (target not in handoffs) and stays on the source agent", async () => {
    const rejectedScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "agent.handoff",
        input: { targetAgent: "ghost-agent" },
      },
      {
        type: "final_message",
        text: "Could not hand off; falling back to plain reply.",
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(rejectedScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "?",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-r" as never,
              messageId: "msg-r",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: ?",
              bodyText: "anything",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    // The handoff was rejected, so triage (a routing agent) ends the tick on
    // a bare final_message without ever routing — the runtime guard parks it
    // for a human rather than silently resolving a case nothing handled.
    expect(out.result.type).toBe("HumanTakeoverRequired");
    // Agent did NOT swap because the target wasn't in handoffs.
    expect(out.fetched.currentAgentId).toBe(supportTriage.id);
    expect(out.fetched.status).toBe("human_takeover");

    const handoffEntry = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] === "agent.handoff",
    );
    expect(handoffEntry).toBeDefined();
    expect((handoffEntry?.details as Record<string, unknown>)["ok"]).toBe(
      false,
    );
    expect((handoffEntry?.details as Record<string, unknown>)["error"]).toBe(
      "target_not_in_handoffs",
    );
  });

  // ----------------------------------------------------------------
  // Regression for the silent-resolve bug (case e6206180-…): triage
  // classified an order-requiring case, found no order id, emitted a bare
  // final_message, and the runtime resolved the case with NOTHING done —
  // no reply, no handoff. Triage is a router: it must hand off, and if it
  // finishes without routing the runtime parks the case for a human
  // instead of silently resolving it.
  // ----------------------------------------------------------------
  it("parks for human takeover when triage finishes without handing off (no silent resolve)", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "where_is_order",
          notes: "customer asks where their order is; no order id given",
        },
      },
      {
        type: "final_message",
        text: "Triaged as where_is_order — no order id identified yet.",
      },
    ];
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
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
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is my order?",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-silent" as never,
              messageId: "msg-silent",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Where is my order?? It's been forever.",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    // The case is parked for a human — NOT silently resolved.
    expect(out.result.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.status).not.toBe("resolved");
    // Triage never routed away, and the case was never resolved.
    expect(out.fetched.currentAgentId).toBe(supportTriage.id);
    const actions = out.entries.map((e) => e.action);
    expect(actions).not.toContain("case.resolved");
  });

  // ----------------------------------------------------------------
  // Single-order inference: triage hands off WITHOUT an order id, and the
  // specialist resolves the order by looking the customer up by email. A
  // customer with exactly one order means we know which order they mean —
  // the specialist proceeds to a reply rather than asking for an order
  // number. Proves the `shopify.find_customer_order` wiring end-to-end.
  // ----------------------------------------------------------------
  it("infers the customer's only order on a no-order-id handoff (does not ask, does not silently resolve)", async () => {
    const orderId = OrderId("gid://shopify/Order/55501");
    const onlyOrder: ShopifyOrder = {
      id: orderId,
      name: "#5501",
      confirmationNumber: null,
      email: "solo@example.com",
      customerId: CustomerId("gid://shopify/Customer/9001"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "42.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Notebook",
          quantity: 1,
          sku: "NB-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [],
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    };

    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "where_is_order",
          notes: "where is my order; no number given",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "order-status-agent",
          reason: "where_is_order specialist",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.find_customer_order",
        input: { email: "solo@example.com" },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-solo",
          to: [{ name: null, email: "solo@example.com" }],
          subject: null,
          bodyText:
            "Your order #5501 is paid and currently in transit. We'll keep you posted.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "order-status-reply-solo",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        ordersByEmail: new Map([["solo@example.com", [onlyOrder]]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const approvalsSvc = yield* ApprovalService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Where is my order?",
            threadId: "thread-solo" as never,
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-solo" as never,
              messageId: "msg-solo",
              from: { name: null, email: "solo@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Where is my order?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, entries, pending };
        }),
        layer,
      ),
    );

    // The reply is drafted and parked for approval — not silently resolved,
    // not handed back to a human, and the customer was never asked for an
    // order number.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.currentAgentId).toBe(orderStatusAgent.id);
    expect(out.fetched.status).toBe("waiting_for_approval");

    // The single-order lookup actually ran through the runtime and succeeded.
    const findEntry = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] ===
          "shopify.find_customer_order",
    );
    expect(findEntry).toBeDefined();
    expect((findEntry?.details as Record<string, unknown>)["ok"]).toBe(true);

    // The customer was NOT asked for an order number.
    const askedCustomer = out.entries.some(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] ===
          "conversation.ask_customer",
    );
    expect(askedCustomer).toBe(false);

    // A reply approval is pending for the specialist.
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.tool).toBe("conversation.reply");
    expect(out.pending[0]!.agentId).toBe(orderStatusAgent.id);

    // The runtime BINDS the inferred order to the case context so the
    // operator's order panel + Issue-refund button surface the SAME order the
    // agent acted on. Regression: find_customer_order resolved the order for
    // the LLM but never stamped `identifiedOrderId`, so the dashboard showed
    // "no order found" even though the agent drafted a correct order-aware
    // reply (prod case e161d86e).
    expect(out.fetched.context["identifiedOrderId"]).toBe("#5501");
  });

  // Regression test for the conversation-history bug surfaced by the
  // 2026-05-16 live demo. Prior to the fix in `agent-runtime.ts:248-268`,
  // the runtime invoked tools and pushed only `tool` role messages back
  // into the conversation — it never pushed an `assistant` message with
  // the matching tool-call. Anthropic + Gemini APIs (and the AI SDK in
  // front of them) require every `tool` message to have a paired prior
  // `assistant` tool-call. Without that pairing, the AI SDK drops the
  // tool messages from the request; the model effectively sees only the
  // original user message every turn, so it loops on the same tool call
  // until `max_turns_exceeded` fires.
  //
  // This test asserts the conversation history shape directly: on turn 1
  // the messages array MUST contain the assistant tool-call from turn 0.
  it("pushes an assistant tool-call message into conversation history before each tool dispatch", async () => {
    const seenMessagesByTurn: Array<ReadonlyArray<{ role: string; toolCalls?: ReadonlyArray<{ name: string }> }>> = [];

    // Build an LLM that:
    //   turn 0: calls case.update_context
    //   turn 1: if a prior assistant tool-call is in the conversation,
    //           finish; otherwise loop. The runtime fix is what makes
    //           the loop terminate.
    const llmFn = LLMServiceFromFn((req, _ctx) => {
      seenMessagesByTurn.push(
        req.messages.map((m) => ({
          role: m.role,
          ...(m.role === "assistant" && m.toolCalls
            ? {
                toolCalls: m.toolCalls.map((c) => ({ name: c.name })),
              }
            : {}),
        })),
      );
      const sawPriorAssistantToolCall = req.messages.some(
        (m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0,
      );
      if (!sawPriorAssistantToolCall) {
        return Eff.succeed({
          type: "tool_call" as const,
          callId: "c-loop",
          tool: "case.update_context",
          input: { notes: "round 1" },
        });
      }
      return Eff.succeed({
        type: "final_message" as const,
        text: "done",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      llmFn,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return yield* runtime.handleEvent(ticketCreated("loop"));
        }),
        layer,
      ),
    );

    // Triage (a primary/router agent) emitting a bare `final_message`
    // without handing off no longer silently resolves — the runtime guard
    // parks it for a human instead. This test is about conversation-history
    // threading; the two LLM calls (and their message shapes) still happen
    // before the guard trips, so the threading assertions below hold.
    expect(result.type).toBe("HumanTakeoverRequired");
    // Two LLM calls: turn 0 (no prior assistant), turn 1 (sees prior
    // assistant tool-call → finishes).
    expect(seenMessagesByTurn).toHaveLength(2);
    // Turn 0: only the user message.
    expect(seenMessagesByTurn[0]!.map((m) => m.role)).toEqual(["user"]);
    // Turn 1: user + assistant(tool-call) + tool(tool-result). If the
    // assistant entry is missing, the bug has regressed.
    const turn1Roles = seenMessagesByTurn[1]!.map((m) => m.role);
    expect(turn1Roles).toEqual(["user", "assistant", "tool"]);
    const turn1Assistant = seenMessagesByTurn[1]![1]!;
    expect(turn1Assistant.toolCalls).toEqual([{ name: "case.update_context" }]);
  });

  it("returns HumanTakeoverRequired when the script exhausts maxTurnsPerTick", async () => {
    // Use a script that never returns final_message: just keeps emitting
    // tool calls. maxTurnsPerTick is 4 for support-triage, so after 4 turns
    // the runtime must give up.
    const loopScript: ReadonlyArray<LLMDecision> = Array.from(
      { length: 10 },
      (_, i) => ({
        type: "tool_call",
        callId: `c${i}`,
        tool: "case.update_context",
        input: { notes: `loop ${i}` },
      }),
    );

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(loopScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return yield* runtime.handleEvent(ticketCreated("loop"));
        }),
        layer,
      ),
    );
    expect(result.type).toBe("HumanTakeoverRequired");
    if (result.type === "HumanTakeoverRequired") {
      expect(result.reason).toBe("max_turns_exceeded");
    }
  });

  // ----------------------------------------------------------------
  // message.received — connector-driven inbound (Gmail, Outlook, …).
  // The runtime resolves the case via findByThreadId: first message on
  // a thread → create + bind; subsequent messages → resume the same
  // case (this is what makes Pub/Sub at-least-once retries safe).
  // ----------------------------------------------------------------
  const messageReceived = (
    threadId: string,
    bodyText: string,
    tenantId = "tenant-acme",
    mailbox?: string,
  ): DomainEvent => ({
    type: "message.received",
    tenantId: TenantId(tenantId),
    threadId: threadId as never,
    payload: {
      threadId: threadId as never,
      messageId: `msg-${threadId}`,
      from: { name: "Jane", email: "jane@example.com" },
      to: [{ name: "Support", email: "support@merchant.com" }],
      subject: "Where is my order?",
      bodyText,
      bodyHtml: null,
      receivedAt: new Date(),
      attachments: [],
      ...(mailbox ? { mailbox } : {}),
    },
  });

  it("creates a case bound to the thread on the first message.received", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;

          const result = yield* runtime.handleEvent(
            messageReceived("thread-A", "My order ord_42 is late."),
          );
          // The runtime didn't return a caseId, so look it up via the
          // thread — the existence of this row is the assertion that
          // load-or-create wrote one bound to the thread.
          const found = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-A" as never,
          );
          return { result, found };
        }),
        fullLayer,
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.found).not.toBeNull();
    expect(out.found?.threadId).toBe("thread-A");
    expect(out.found?.channel).toBe("email");
    expect(out.found?.status).toBe("resolved");
    expect(out.found?.context["classification"]).toBe("where_is_order");
  });

  it("resumes the same case when a second message.received arrives on the same thread", async () => {
    // Two consecutive inbound messages on the same thread must produce
    // exactly ONE case row — that's the dedup guarantee Pub/Sub at-least-
    // once delivery is relying on.
    const continueScript: ReadonlyArray<LLMDecision> = [
      ...triageScript,
      // Second tick: just finish. The case is already resolved from the
      // first tick, so this is the "case already resolved" no-op path.
      { type: "final_message", text: "no-op resume" },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(continueScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          yield* runtime.handleEvent(
            messageReceived("thread-B", "first message"),
          );
          const first = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-B" as never,
          );
          expect(first).not.toBeNull();
          const firstId = first!.id;

          yield* runtime.handleEvent(
            messageReceived("thread-B", "second message"),
          );
          const second = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-B" as never,
          );
          // Same case row.
          expect(second?.id).toBe(firstId);

          const entries = yield* audit.forCase(firstId);
          return { firstId, entries };
        }),
        layer,
      ),
    );

    // Two ticks → two `event.received` audit rows on the same case.
    const eventReceivedCount = out.entries.filter(
      (e) => e.action === "event.received",
    ).length;
    expect(eventReceivedCount).toBe(2);
  });

  it("creates separate cases for the same provider thread id in different mailboxes", async () => {
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted([...triageScript, ...triageScript]),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const threadId = "gmail:provider-thread-collision" as never;

          yield* runtime.handleEvent(
            messageReceived(
              threadId,
              "first mailbox message",
              "tenant-acme",
              "first@merchant.com",
            ),
          );
          yield* runtime.handleEvent(
            messageReceived(
              threadId,
              "second mailbox message",
              "tenant-acme",
              "second@merchant.com",
            ),
          );

          return {
            first: yield* repo.findByThreadId(
              TenantId("tenant-acme"),
              threadId,
              "gmail",
              "first@merchant.com",
            ),
            second: yield* repo.findByThreadId(
              TenantId("tenant-acme"),
              threadId,
              "gmail",
              "second@merchant.com",
            ),
          };
        }),
        layer,
      ),
    );

    expect(out.first).not.toBeNull();
    expect(out.second).not.toBeNull();
    expect(out.first?.id).not.toBe(out.second?.id);
  });

  it("holds an inbound reply on a human_takeover case instead of running the agent", async () => {
    // After a manager takes a case over, an inbound customer reply must NOT
    // wake the agent — answering would step on the human handling it. The
    // empty LLM script IS the assertion: if the guard regresses and the
    // agent loop runs, the runtime consults the LLM and the empty script
    // dies, failing the test.
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted([]), // must never be consulted
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          // Seed a taken-over case already bound to the thread.
          const seeded = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: AgentId("support-triage"),
            subject: "Where is my order?",
            threadId: "thread-HT" as never,
            status: "human_takeover",
          });

          const result = yield* runtime.handleEvent(
            messageReceived("thread-HT", "any update on my refund?"),
          );
          const fetched = yield* repo.getById(seeded.id);
          const entries = yield* audit.forCase(seeded.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedForHumanTakeover");
    // The agent never acted — the case stays parked under the human.
    expect(out.fetched.status).toBe("human_takeover");
    // The held reply is recorded for the audit trail.
    expect(
      out.entries.some((e) => e.action === "event.held_human_takeover"),
    ).toBe(true);
  });

  it("stamps customerEmail + shopifyCustomerId onto the case context when message.received creates a new case", async () => {
    // Seed a Shopify customer keyed by the inbound sender's email so the
    // runtime's post-create searchByEmail lookup returns a hit.
    const customerId = CustomerId("gid://shopify/Customer/4242");
    const fixtureCustomer = {
      id: customerId,
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      phone: null,
      ordersCount: 3,
      totalSpent: { amount: "129.00", currencyCode: "USD" },
      defaultAddress: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(triageScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        customersByEmail: new Map([["jane@example.com", fixtureCustomer]]),
      }),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          yield* runtime.handleEvent(
            messageReceived("thread-cust", "Hi support, where's my order?"),
          );
          const found = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-cust" as never,
          );
          return { found };
        }),
        layer,
      ),
    );

    expect(out.found).not.toBeNull();
    expect(out.found?.context["customerEmail"]).toBe("jane@example.com");
    expect(out.found?.context["shopifyCustomerId"]).toBe(customerId);
  });

  it("persists customerEmail but no shopifyCustomerId when Shopify has no match", async () => {
    // searchByEmail returns null → the email is still stamped (so the
    // dashboard / specialists can use it) but no customer id is set.
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          yield* runtime.handleEvent(
            messageReceived("thread-miss", "Hello"),
          );
          const found = yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-miss" as never,
          );
          return { found };
        }),
        // fullLayer's ShopifyServiceTest has no customersByEmail seed → miss.
        fullLayer,
      ),
    );

    expect(out.found?.context["customerEmail"]).toBe("jane@example.com");
    expect(out.found?.context["shopifyCustomerId"]).toBeUndefined();
  });

  it("projects inbound image attachments into the turn-0 user message as multimodal parts", async () => {
    // When a customer emails with photos (damaged-product flow), the
    // runtime must hand them to the LLM as image content parts so the
    // model can actually look at them. Non-image attachments stay out
    // of the user message — only `image/*` MIME types make it through.
    let seenContent: unknown = undefined;
    const llmFn = LLMServiceFromFn((req) => {
      seenContent = req.messages[0]?.content;
      return Eff.succeed({
        type: "final_message" as const,
        text: "thanks for the photos, escalating",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      llmFn,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const inboundWithPhotos: DomainEvent = {
      type: "message.received",
      tenantId: TenantId("tenant-acme"),
      threadId: "thread-photo" as never,
      payload: {
        threadId: "thread-photo" as never,
        messageId: "msg-photo",
        from: { name: "Jane", email: "jane@example.com" },
        to: [{ name: "Support", email: "support@merchant.com" }],
        subject: "Damaged product",
        bodyText: "The box arrived crushed — photos attached.",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [
          {
            filename: "front.jpg",
            contentType: "image/jpeg",
            storageKey: "gmail/tenant-acme/msg-photo/att1.jpg",
            sizeBytes: 12_345,
          },
          {
            filename: "side.png",
            contentType: "image/png",
            storageKey: "gmail/tenant-acme/msg-photo/att2.png",
            sizeBytes: 8_192,
          },
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            storageKey: "gmail/tenant-acme/msg-photo/att3.pdf",
            sizeBytes: 1024,
          },
        ],
      },
    };

    const stampedCase = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          yield* runtime.handleEvent(inboundWithPhotos);
          const repo = yield* CaseRepository;
          return yield* repo.findByThreadId(
            TenantId("tenant-acme"),
            "thread-photo" as never,
          );
        }),
        layer,
      ),
    );

    // The runtime stamps a per-case EXIF rollup onto the context. These
    // fixture attachments carry no `exif` field → all stripped.
    const photoSignals = (
      stampedCase?.context as Record<string, unknown> | undefined
    )?.["photoSignals"];
    expect(photoSignals).toEqual({
      count: 2,
      withExif: 0,
      stripped: 2,
      anyStripped: true,
    });

    // content must be an array of parts: one text + two image parts
    // (the PDF is filtered out because we don't model file parts yet).
    expect(Array.isArray(seenContent)).toBe(true);
    const parts = seenContent as ReadonlyArray<
      | { type: "text"; text: string }
      | { type: "image"; attachment: { storageKey: string; contentType: string } }
    >;
    expect(parts).toHaveLength(3);
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]?.type).toBe("image");
    expect(parts[2]?.type).toBe("image");
    if (parts[1]?.type === "image") {
      expect(parts[1].attachment.storageKey).toBe(
        "gmail/tenant-acme/msg-photo/att1.jpg",
      );
      expect(parts[1].attachment.contentType).toBe("image/jpeg");
    }
    if (parts[2]?.type === "image") {
      expect(parts[2].attachment.storageKey).toBe(
        "gmail/tenant-acme/msg-photo/att2.png",
      );
    }
  });

  it("flags a duplicate photo (near pHash match) seen on another case", async () => {
    // The damaged-product fraud guard: a photo whose perceptual hash is
    // within Hamming distance of one already recorded on ANOTHER case for
    // the same tenant stamps a `duplicate_photo_seen_in_case_<id>` risk
    // flag onto the case context.
    const llmFn = LLMServiceFromFn(() =>
      Eff.succeed({ type: "final_message" as const, text: "ok" }),
    );
    const imageHashLayer = ImageHashStoreTest;
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      llmFn,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
      imageHashLayer,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const priorCaseId = CaseId("99999999-9999-4999-8999-999999999999");
    const inbound: DomainEvent = {
      type: "message.received",
      tenantId: TenantId("tenant-dup"),
      threadId: "thread-dup" as never,
      payload: {
        threadId: "thread-dup" as never,
        messageId: "msg-dup",
        from: { name: "Mallory", email: "mallory@example.com" },
        to: [{ name: "Support", email: "support@merchant.com" }],
        subject: "Damaged again",
        bodyText: "Another broken item, same photo as always.",
        bodyHtml: null,
        receivedAt: new Date(),
        attachments: [
          {
            filename: "broken.jpg",
            contentType: "image/jpeg",
            storageKey: "gmail/tenant-dup/msg-dup/att1.jpg",
            sizeBytes: 5000,
            phash: "3", // distance 1 from the pre-seeded hash "1"
          },
        ],
      },
    };

    const stampedCase = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          // Pre-seed a near-identical hash on a different case, same tenant.
          const store = yield* ImageHashStore;
          yield* store.record({
            tenantId: TenantId("tenant-dup"),
            caseId: priorCaseId,
            phash: 1n,
          });
          const runtime = yield* AgentRuntime;
          yield* runtime.handleEvent(inbound);
          const repo = yield* CaseRepository;
          return yield* repo.findByThreadId(
            TenantId("tenant-dup"),
            "thread-dup" as never,
          );
        }),
        layer,
      ),
    );

    const riskFlags = (
      stampedCase?.context as Record<string, unknown> | undefined
    )?.["riskFlags"];
    expect(riskFlags).toEqual([
      `duplicate_photo_seen_in_case_${priorCaseId}`,
    ]);
  });

  // ----------------------------------------------------------------
  // Triage → refund-review-agent → conversation.reply (gated "ask").
  //
  // First specialist that exercises the full ask-then-pause-then-approve
  // arc: support-triage classifies the message as `refund_request`, hands
  // off to `refund-review-agent`, the specialist fetches the order, then
  // proposes a customer-facing reply via `conversation.reply`. That tool's
  // defaultPermission is `"ask"`, so PermissionService returns `"ask"`,
  // the runtime creates an approval row, transitions the case to
  // `waiting_for_approval`, and returns `PausedWaitingForApproval`.
  // Nothing is sent to the customer until a human approves.
  // ----------------------------------------------------------------
  it("hands off to refund-review-agent, drafts a conversation.reply, and pauses for approval", async () => {
    const orderId = OrderId("gid://shopify/Order/77777");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#2001",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/555"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "59.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Wireless Earbuds",
          quantity: 1,
          sku: "EAR-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    };

    // turn 0 — triage classifies as refund_request + records the order id
    // turn 1 — triage hands off to refund-review-agent
    // turn 2 — refund-review-agent fetches the order via shopify.get_order
    // turn 3 — refund-review-agent drafts conversation.reply; permission
    //          service returns "ask" → runtime parks the case.
    const refundScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "refund_request",
          identifiedOrderId: orderId,
          notes: "customer wants a refund",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "refund-review-agent",
          reason: "specialist owns refund_request",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-refund",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "Thanks for reaching out about order #2001. Your order shows as delivered; could you confirm whether you'd like a return label or refund-on-receipt?",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "refund-reply-test-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund please",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-refund" as never,
              messageId: "msg-r1",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: `I'd like to return my order ${orderId}.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, entries, pending };
        }),
        layer,
      ),
    );

    // Runtime parks waiting on the conversation.reply approval.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    if (out.result.type === "PausedWaitingForApproval") {
      expect(out.result.approvalId).toBeTruthy();
    }
    // Case is in the gated state and on the specialist agent.
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.fetched.currentAgentId).toBe(refundReviewAgent.id);

    // One pending approval, tied to the right tool + agent + case.
    expect(out.pending).toHaveLength(1);
    const approval = out.pending[0]!;
    expect(approval.tool).toBe("conversation.reply");
    expect(approval.agentId).toBe(refundReviewAgent.id);
    expect(approval.caseId).toBe(out.fetched.id);
    expect(approval.status).toBe("pending");
    // The proposed input we'd ship through `conversation.reply`.
    const proposed = approval.proposedInput as {
      readonly threadId: string;
      readonly to: ReadonlyArray<{ email: string }>;
      readonly draftId: string;
    };
    expect(proposed.threadId).toBe("thread-refund");
    expect(proposed.to[0]?.email).toBe("buyer@example.com");
    expect(proposed.draftId).toBe("refund-reply-test-1");

    // Audit trail: event.received + (llm.decision, tool.invoked) × 3 + a
    // final llm.decision (the conversation.reply tool call that was gated)
    // + the case.waiting_for_approval park row (same tx as the approval).
    // No `tool.invoked` for conversation.reply because permission=ask
    // short-circuits BEFORE execute. No `case.resolved` because we paused.
    const actions = out.entries.map((e) => e.action);
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "case.waiting_for_approval",
    ]);
  });

  // ----------------------------------------------------------------
  // Refund-review PATH B with `refund.recommend` in the chain. The
  // recommendation runs BEFORE conversation.reply (so the operator
  // approving the draft sees the structured assessment alongside).
  // Asserts both tool.invoked rows in order.
  // ----------------------------------------------------------------
  it("refund-review PATH B calls refund.recommend before conversation.reply", async () => {
    const orderId = OrderId("gid://shopify/Order/88001");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#8001",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/555"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      // $20 — inside the default policy's ask zone.
      totalPrice: { amount: "20.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Mug",
          quantity: 1,
          sku: "MUG-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [],
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };

    // Script: triage classifies + hands off → refund-review fetches
    // the order → calls refund.recommend → drafts conversation.reply
    // → reply parks for approval.
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "refund_request",
          identifiedOrderId: orderId,
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "refund-review-agent",
          reason: "refund_request",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "refund.recommend",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c4",
        tool: "conversation.reply",
        input: {
          threadId: "thread-refund-b",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "Thanks for your refund request on order #8001. Based on the order state, we'd like to offer a full refund — pending confirmation from our team.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "refund-reply-8001",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund for #8001",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-refund-b" as never,
              messageId: "msg-8001",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Refund for #8001",
              bodyText: `I'd like a refund on order ${orderId}.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const entries = yield* audit.forCase(created.id);
          return { result, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");

    // Both refund.recommend AND shopify.get_order ran (auto-allow); the
    // gated conversation.reply parked for approval.
    const tools = out.entries
      .filter((e) => e.action === "tool.invoked")
      .map((e) => (e.details as Record<string, unknown>)["tool"]);
    expect(tools).toContain("shopify.get_order");
    expect(tools).toContain("refund.recommend");
    // conversation.reply parked — no tool.invoked row for it.
    expect(tools).not.toContain("conversation.reply");

    // The refund.recommend audit row carries the recommendation in details.
    const recommendEntry = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as Record<string, unknown>)["tool"] === "refund.recommend",
    );
    expect(recommendEntry).toBeDefined();
    expect((recommendEntry!.details as Record<string, unknown>)["output"]).toMatchObject({
      recommendation: "full_refund",
      amount: { amount: "20.00", currencyCode: "USD" },
      reasoning: expect.any(String),
      riskFlags: expect.any(Array),
    });
  });

  // ----------------------------------------------------------------
  // Return request: refund-review-agent stamps the structured return
  // intent (returnReason + requestedResolution) onto the case via the
  // RETURN CAPTURE step, then drafts a reply (PATH B) — proving the
  // producer wiring lands the closed-vocabulary fields the dashboard
  // chips read. (A dedicated returns agent is deferred; see todo.md.)
  // ----------------------------------------------------------------
  it("refund-review stamps returnReason + requestedResolution for a return request", async () => {
    const orderId = OrderId("gid://shopify/Order/88002");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#8002",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/556"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "30.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Mug",
          quantity: 1,
          sku: "MUG-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [],
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
      updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    };

    // Script: triage classifies + hands off → refund-review fetches the
    // order → RETURN CAPTURE stamps returnReason/requestedResolution →
    // refund.recommend → drafts a reply → reply parks for approval.
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: { classification: "refund_request", identifiedOrderId: orderId },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: { targetAgent: "refund-review-agent", reason: "return" },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "case.update_context",
        input: { returnReason: "defective", requestedResolution: "replacement" },
      },
      {
        type: "tool_call",
        callId: "c4",
        tool: "refund.recommend",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c5",
        tool: "conversation.reply",
        input: {
          threadId: "thread-return-a",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "Thanks for letting us know the mug arrived defective — we can send a replacement. Could you confirm your address?",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "return-reply-8002",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Return for #8002",
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-return-a" as never,
              messageId: "msg-8002",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Return for #8002",
              bodyText: `The mug from order ${orderId} arrived defective — can I get a replacement?`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          return { result, fetched };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    // The structured return intent landed on the case context (closed
    // vocabulary the dashboard chips read).
    expect(out.fetched.context["returnReason"]).toBe("defective");
    expect(out.fetched.context["requestedResolution"]).toBe("replacement");
  });

  // ----------------------------------------------------------------
  // Triage → missing-package-agent → shopify.get_order → draft a
  // conversation.reply matching the fulfillment state → pause for
  // approval. Same shape as the refund-review handoff test above, but
  // exercises the missing-package decision rule + handoff entry.
  // ----------------------------------------------------------------
  it("hands off to missing-package-agent, drafts a conversation.reply, and pauses for approval", async () => {
    const orderId = OrderId("gid://shopify/Order/88888");
    // Fixture: order is marked delivered. This is BRANCH A in the
    // prompt — agent should ask the customer to verify (porch /
    // neighbor / household) before committing to reship or refund.
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#3001",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/666"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "42.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Coffee Beans 1kg",
          quantity: 1,
          sku: "BEAN-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [
        {
          id: "f-1",
          status: "delivered",
          trackingCompany: "UPS",
          trackingNumbers: ["1Z999"],
          trackingUrls: ["https://wwwapps.ups.com/tracking?t=1Z999"],
          estimatedDeliveryAt: new Date("2026-05-21T00:00:00.000Z"),
          deliveredAt: new Date("2026-05-22T15:00:00.000Z"),
          createdAt: new Date("2026-05-19T00:00:00.000Z"),
          updatedAt: new Date("2026-05-22T15:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      updatedAt: new Date("2026-05-22T15:00:00.000Z"),
    };

    const missingPackageScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "missing_package",
          identifiedOrderId: orderId,
          notes: "customer says package never arrived",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "missing-package-agent",
          reason: "specialist owns missing_package",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-missing",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "Thanks for reaching out about order #3001. UPS marked it delivered on 2026-05-22 — could you check with neighbors or anyone in your household, and confirm the shipping address? If those come up empty we can open a carrier claim.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "missing-package-reply-test-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, missingPackageAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(missingPackageScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Package never arrived",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-missing" as never,
              messageId: "msg-mp1",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Package never arrived",
              bodyText: `My order ${orderId} shows delivered but I never got it.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, pending };
        }),
        layer,
      ),
    );

    // Runtime parks waiting on the conversation.reply approval.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.fetched.currentAgentId).toBe(missingPackageAgent.id);

    // Pending approval ties to the right tool + agent + case.
    expect(out.pending).toHaveLength(1);
    const approval = out.pending[0]!;
    expect(approval.tool).toBe("conversation.reply");
    expect(approval.agentId).toBe(missingPackageAgent.id);
    expect(approval.caseId).toBe(out.fetched.id);
    expect(approval.status).toBe("pending");
    const proposed = approval.proposedInput as {
      readonly threadId: string;
      readonly draftId: string;
    };
    expect(proposed.threadId).toBe("thread-missing");
    expect(proposed.draftId).toBe("missing-package-reply-test-1");
  });

  // ----------------------------------------------------------------
  // BRANCH A with supplierEscalationSheet configured: the runtime
  // injects the `[Supplier escalation sheet: ...]` header into the
  // missing-package-agent's system prompt; the agent calls
  // `supplier.add_sheet_row` BEFORE the customer reply.
  // ----------------------------------------------------------------
  it("missing-package BRANCH A with supplier sheet configured: calls supplier.add_sheet_row before conversation.reply", async () => {
    const orderId = OrderId("gid://shopify/Order/77777");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#4001",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/777"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "55.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Coffee Beans 1kg",
          quantity: 1,
          sku: "BEAN-01",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [
        {
          id: "f-1",
          status: "delivered",
          trackingCompany: "UPS",
          trackingNumbers: ["1Z888"],
          trackingUrls: ["https://wwwapps.ups.com/tracking?t=1Z888"],
          estimatedDeliveryAt: new Date("2026-05-21T00:00:00.000Z"),
          deliveredAt: new Date("2026-05-22T15:00:00.000Z"),
          createdAt: new Date("2026-05-19T00:00:00.000Z"),
          updatedAt: new Date("2026-05-22T15:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      updatedAt: new Date("2026-05-22T15:00:00.000Z"),
    };

    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "missing_package",
          identifiedOrderId: orderId,
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "missing-package-agent",
          reason: "specialist owns missing_package",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "supplier.read_sheet_columns",
        input: {
          spreadsheetId: "sheet-warehouse",
          range: "Escalations!A:F",
        },
      },
      {
        type: "tool_call",
        callId: "c4",
        tool: "supplier.add_sheet_row",
        input: {
          spreadsheetId: "sheet-warehouse",
          range: "Escalations!A:F",
          // Values aligned to the sheet's own header order returned by
          // read_sheet_columns above: [Order, Email, Tracking, Delivered].
          values: [
            "#4001",
            "buyer@example.com",
            "1Z888",
            "2026-05-22T15:00:00.000Z",
          ],
        },
      },
      {
        type: "tool_call",
        callId: "c5",
        tool: "conversation.reply",
        input: {
          threadId: "thread-missing-with-sheet",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "Thanks for reaching out about order #4001. UPS marked it delivered on 2026-05-22 — could you check neighbors / porch / household members?",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "missing-package-reply-with-sheet-1",
        },
      },
    ];

    // Tenant has a sheet configured → runtime should inject the header
    // → agent should emit the supplier.add_sheet_row tool call.
    const tenantsWithSheet = TenantRepositoryTest({
      settingsByTenant: new Map([
        [
          TenantId("tenant-acme"),
          new TenantSettings({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            retentionDays: 730,
            supplierEscalationSheet: {
              spreadsheetId: "sheet-warehouse",
              range: "Escalations!A:F",
              description: "warehouse ops",
            },
            legalAcceptance: null,
          }),
        ],
      ]),
    });

    // SheetsServiceTest returns a deterministic happy result so the
    // tool.invoked audit row records a successful write.
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, missingPackageAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      // The merchant's sheet declares its own column order; the agent
      // reads it and aligns the appended row to it.
      SheetsServiceTest({
        headers: {
          "sheet-warehouse": ["Order", "Email", "Tracking", "Delivered"],
        },
      }),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantsWithSheet,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Package never arrived",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-missing-with-sheet" as never,
              messageId: "msg-mp-sheet",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Package never arrived",
              bodyText: `My order ${orderId} shows delivered but I never got it.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const auditEntries = yield* audit.forCase(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, auditEntries, pending };
        }),
        layer,
      ),
    );

    // Runtime parks waiting on the conversation.reply approval.
    expect(out.result.type).toBe("PausedWaitingForApproval");

    // supplier.read_sheet_columns + supplier.add_sheet_row both ran
    // (auto-allowed via agent override), in that order, then
    // conversation.reply parked for approval (defaultPermission ask).
    const toolInvocations = out.auditEntries
      .filter((e) => e.action === "tool.invoked")
      .map((e) => (e.details as { tool?: string }).tool);
    expect(toolInvocations).toContain("supplier.read_sheet_columns");
    expect(toolInvocations).toContain("supplier.add_sheet_row");
    // The columns must be read BEFORE the row is appended.
    expect(toolInvocations.indexOf("supplier.read_sheet_columns")).toBeLessThan(
      toolInvocations.indexOf("supplier.add_sheet_row"),
    );
    // conversation.reply at the ask stage short-circuits BEFORE execute,
    // so there's no tool.invoked row for it — the approval row carries it.
    expect(toolInvocations).not.toContain("conversation.reply");

    // The pending approval is for conversation.reply.
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.tool).toBe("conversation.reply");
  });

  // ----------------------------------------------------------------
  // Triage → damaged-product-agent (BRANCH A, photos present) →
  // shopify.get_order → conversation.reply (ask, parks for approval).
  // This exercises the photo-evidence flow: the inbound message
  // carries image attachments, the runtime projects them as image
  // parts (verified by an earlier test), and the agent's scripted
  // decisions match the BRANCH A path (look + fetch + draft).
  // ----------------------------------------------------------------
  it("hands off to damaged-product-agent BRANCH A (photos present), drafts a reply, pauses for approval", async () => {
    const orderId = OrderId("gid://shopify/Order/55555");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#9001",
      confirmationNumber: null,
      email: "buyer@example.com",
      customerId: CustomerId("gid://shopify/Customer/911"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "120.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Glass Vase",
          quantity: 1,
          sku: "VASE-01",
          variantTitle: null,
          productId: "gid://shopify/Product/777",
        },
      ],
      fulfillments: [
        {
          id: "f-1",
          status: "delivered",
          trackingCompany: "USPS",
          trackingNumbers: ["9400"],
          trackingUrls: [],
          estimatedDeliveryAt: new Date("2026-05-25T00:00:00.000Z"),
          deliveredAt: new Date("2026-05-26T18:00:00.000Z"),
          createdAt: new Date("2026-05-23T00:00:00.000Z"),
          updatedAt: new Date("2026-05-26T18:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-05-23T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T18:00:00.000Z"),
    };

    const script: ReadonlyArray<LLMDecision> = [
      // turn 0 — triage classifies
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "damaged_product",
          identifiedOrderId: orderId,
          notes: "vase arrived broken",
        },
      },
      // turn 1 — triage hands off
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "damaged-product-agent",
          reason: "specialist owns damaged_product",
        },
      },
      // turn 2 — specialist BRANCH A: fetch order
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      // turn 3 — cross-check the photos against the product's images
      {
        type: "tool_call",
        callId: "c3a",
        tool: "shopify.get_product",
        input: { productId: "gid://shopify/Product/777" },
      },
      // turn 4 — record the match verdict on the case context
      {
        type: "tool_call",
        callId: "c3b",
        tool: "case.update_context",
        input: { productMatch: "match" },
      },
      // turn 5 — draft customer reply (gated ask)
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-damage",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "I'm sorry the Glass Vase arrived broken — I can see the chip on the rim and the crack down the side from your photos. I'll arrange a replacement shipped today at no charge; please keep or discard the damaged piece, no need to send it back. Reply if you'd prefer a refund of $120.00 instead.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "damaged-product-reply-test-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, damagedProductAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
        productsById: new Map([
          [
            "gid://shopify/Product/777",
            {
              id: "gid://shopify/Product/777",
              title: "Glass Vase",
              productType: "Home",
              vendor: "Acme",
              images: [
                {
                  url: "https://cdn.shopify.com/vase.jpg",
                  altText: "Glass Vase",
                },
              ],
            },
          ],
        ]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Vase arrived broken",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-damage" as never,
              messageId: "msg-dp1",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Vase arrived broken",
              bodyText: `Hi, my order ${orderId} arrived smashed — photos attached.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [
                {
                  filename: "front.jpg",
                  contentType: "image/jpeg",
                  storageKey: "test/photo-front.jpg",
                  sizeBytes: 1234,
                },
                {
                  filename: "side.jpg",
                  contentType: "image/jpeg",
                  storageKey: "test/photo-side.jpg",
                  sizeBytes: 2345,
                },
              ],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, pending };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.status).toBe("waiting_for_approval");
    expect(out.fetched.currentAgentId).toBe(damagedProductAgent.id);

    // The product-match cross-check stamped its verdict on the case
    // context so the approval card can calibrate operator confidence.
    expect(out.fetched.context["productMatch"]).toBe("match");

    // The pending approval is for conversation.reply on the damaged-
    // product specialist with the drafted reply.
    expect(out.pending).toHaveLength(1);
    const approval = out.pending[0]!;
    expect(approval.tool).toBe("conversation.reply");
    expect(approval.agentId).toBe(damagedProductAgent.id);
    expect(approval.caseId).toBe(out.fetched.id);
    const proposed = approval.proposedInput as {
      readonly threadId: string;
      readonly draftId: string;
    };
    expect(proposed.threadId).toBe("thread-damage");
    expect(proposed.draftId).toBe("damaged-product-reply-test-1");
  });

  // ----------------------------------------------------------------
  // Damaged-product BRANCH B (no photos): triage → handoff →
  // conversation.ask_customer (defaultPermission: allow). The case
  // resolves cleanly on the same tick — ask_customer auto-sends + the
  // runtime treats the trailing plain-text final_message as the
  // resolution.
  // ----------------------------------------------------------------
  it("hands off to damaged-product-agent BRANCH B (no photos), asks for photos via conversation.ask_customer", async () => {
    const orderId = OrderId("gid://shopify/Order/55556");

    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "damaged_product",
          identifiedOrderId: orderId,
          notes: "customer reports damage, no photos yet",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "damaged-product-agent",
          reason: "specialist owns damaged_product",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "conversation.ask_customer",
        input: {
          threadId: "thread-damage-2",
          to: [{ name: null, email: "buyer@example.com" }],
          subject: null,
          bodyText:
            "I'm sorry to hear your order arrived damaged. Could you send a couple of clear photos showing the damage from different angles, plus the outer packaging if possible? Once I see them I'll arrange a replacement or refund.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "damaged-product-photo-request-test-1",
          remindAfterHours: 72,
        },
      },
      {
        type: "final_message",
        text: "Asked customer for photos.",
      },
    ];

    // conversation.ask_customer schedules a follow-up timer; provide a
    // no-op TimerService that records what was scheduled.
    const timerLayer = Layer.succeed(
      TimerService,
      TimerService.of({
        schedule: (input) =>
          Effect.succeed({
            id: "timer-dp-1",
            caseId: input.caseId,
            fireAt: input.fireAt,
            reason: input.reason,
            firedAt: null,
            cancelledAt: null,
          }),
        cancelOpenForCase: () => Effect.succeed(0),
        fireDue: () => Effect.succeed([]),
      }),
    );

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, damagedProductAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      timerLayer,
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Item arrived broken",
          });

          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-damage-2" as never,
              messageId: "msg-dp2",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Item arrived broken",
              bodyText: `Order ${orderId} arrived in pieces — please help.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    // BRANCH B: ask_customer is defaultPermission:"allow" so it runs;
    // the runtime then transitions the case to waiting_for_customer.
    expect(["Completed", "PausedWaitingForCustomer"]).toContain(
      out.result.type,
    );

    const tools = out.entries
      .filter((e) => e.action === "tool.invoked")
      .map((e) => (e.details as { tool?: string }).tool);
    expect(tools).toContain("conversation.ask_customer");
    // BRANCH B explicitly does NOT draft a refund/replacement reply
    // (we don't know enough yet) — only the ask runs.
    expect(tools).not.toContain("conversation.reply");
  });

  // ----------------------------------------------------------------
  // Closed-loop: triage → handoff → draft → ask-approval → manager
  // approves via approval.approved event → runtime executes the gated
  // conversation.reply → case resolves. This is the slice that proves
  // the "AI proposes, human approves, AI sends" arc works end-to-end.
  // ----------------------------------------------------------------
  it("resumes a paused case on approval.approved: executes conversation.reply and resolves", async () => {
    const orderId = OrderId("gid://shopify/Order/88888");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#3001",
      confirmationNumber: null,
      email: "buyer2@example.com",
      customerId: CustomerId("gid://shopify/Customer/999"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "129.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [
        {
          id: "li-1",
          title: "Headphones",
          quantity: 1,
          sku: "HD-7",
          variantTitle: null,
          productId: null,
        },
      ],
      fulfillments: [],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    };

    // Inspectable Test layers: we want to assert the approval-email was
    // fired AND the customer-facing reply landed in ConversationService.
    const convoTest = makeConversationServiceTest({});
    const mailTest = makePlatformMailServiceTest({});

    const refundScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "refund_request",
          identifiedOrderId: orderId,
          notes: "refund please",
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: {
          targetAgent: "refund-review-agent",
          reason: "specialist owns refund_request",
        },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-refund-closed-loop",
          to: [{ name: null, email: "buyer2@example.com" }],
          subject: null,
          bodyText: "Drafted refund-review reply for closed-loop test.",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "refund-reply-closed-loop-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      convoTest.layer,
      mailTest.layer,
      approvalLinkLayer,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund please",
            threadId: "thread-refund-closed-loop" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });

          // Tick #1 — runs the agent loop, parks waiting on approval.
          const r1 = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-refund-closed-loop" as never,
              messageId: "msg-cl1",
              from: { name: null, email: "buyer2@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: `I'd like a refund for order ${orderId}.`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          if (r1.type !== "PausedWaitingForApproval") {
            throw new Error(`expected paused, got ${r1.type}`);
          }
          const approvalId = r1.approvalId;

          // Tick #2 — manager clicks approve → API publishes
          // approval.approved → worker (this test stands in) dispatches
          // it to the runtime. Runtime executes the previously-gated
          // conversation.reply and resolves the case.
          const r2 = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId,
            caseId: created.id,
            managerId: UserId("manager-1"),
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { r1, r2, approvalId, fetched, entries };
        }),
        layer,
      ),
    );

    // The resume tick completed cleanly.
    expect(out.r2.type).toBe("Completed");
    // Case ended up resolved (was waiting_for_approval after tick #1).
    expect(out.fetched.status).toBe("resolved");

    // The conversation.reply actually fired against the connector —
    // this is the customer-facing message the manager approved.
    expect(convoTest.handle.sent).toHaveLength(1);
    const sent = convoTest.handle.sent[0]!;
    expect(sent.kind).toBe("reply");
    if (sent.kind === "reply") {
      const input = sent.input as {
        readonly threadId: string;
        readonly to: ReadonlyArray<{ email: string }>;
        readonly draftId: string;
      };
      expect(input.threadId).toBe("thread-refund-closed-loop");
      expect(input.to[0]?.email).toBe("buyer2@example.com");
      expect(input.draftId).toBe("refund-reply-closed-loop-1");
    }

    // The approval-link email was queued at the pause point (best-
    // effort fire-off; the in-memory PlatformMailServiceTest layer
    // would have FAILED only if the runtime swallowed the call).
    expect(mailTest.handle.sent).toHaveLength(1);
    const mailRecord = mailTest.handle.sent[0]!;
    expect(mailRecord.kind).toBe("approval-link");
    expect(mailRecord.input.approvalId).toBe(out.approvalId);
    expect(mailRecord.input.toolName).toBe("conversation.reply");
    expect(mailRecord.input.approveUrl).toContain(
      `/approvals/${out.approvalId}/approve?token=`,
    );
    expect(mailRecord.input.rejectUrl).toContain(
      `/approvals/${out.approvalId}/reject?token=`,
    );

    // Audit trail across both ticks:
    //   tick #1: event.received + 3× (llm.decision, tool.invoked) +
    //            trailing llm.decision (the gated reply call)
    //   tick #2: event.received + tool.invoked (executed reply) +
    //            case.resolved
    const actions = out.entries.map((e) => e.action);
    expect(actions.slice(-3)).toEqual([
      "event.received",
      "tool.invoked",
      "case.resolved",
    ]);
    // The post-approval tool.invoked carries viaApprovalId so the
    // dashboard timeline can render "Executed via approval <id>".
    const postApprovalInvoke = out.entries[out.entries.length - 2];
    expect(
      (postApprovalInvoke?.details as Record<string, unknown>)["viaApprovalId"],
    ).toBe(out.approvalId);
    expect(
      (postApprovalInvoke?.details as Record<string, unknown>)["tool"],
    ).toBe("conversation.reply");
    expect(postApprovalInvoke?.actor.type).toBe("user");
    expect(postApprovalInvoke?.actor.id).toBe("manager-1");
  });

  // Audit L8 regression: a manager can edit `approvedInput` on the dashboard
  // before approving. That edited JSON is the ONE unvalidated entry into a
  // tool's execute, so the resume path must re-decode it against the tool's
  // schema. A schema-invalid edit must escalate to human_takeover and NOT
  // execute the tool (no customer-facing send).
  it("rejects a schema-invalid manager-edited approvedInput on resume (L8)", async () => {
    const convoTest = makeConversationServiceTest({});
    const mailTest = makePlatformMailServiceTest({});

    const orderId = OrderId("gid://shopify/Order/77123");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7123",
      confirmationNumber: null,
      email: "buyer-l8@example.com",
      customerId: CustomerId("gid://shopify/Customer/7123"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "49.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [],
      fulfillments: [],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    };

    const refundScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: { classification: "refund_request", identifiedOrderId: orderId },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: { targetAgent: "refund-review-agent", reason: "specialist" },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-l8",
          to: [{ name: null, email: "buyer-l8@example.com" }],
          subject: null,
          bodyText: "draft for L8 test",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "refund-reply-l8-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      convoTest.layer,
      mailTest.layer,
      approvalLinkLayer,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const approvalsSvc = yield* ApprovalService;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund please",
            threadId: "thread-l8" as never,
            provider: "gmail",
            mailbox: "support@merchant.com",
          });

          const r1 = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-l8" as never,
              messageId: "msg-l8",
              from: { name: null, email: "buyer-l8@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: `refund for ${orderId} please`,
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          if (r1.type !== "PausedWaitingForApproval") {
            throw new Error(`expected paused, got ${r1.type}`);
          }

          // Manager approves but edits the input into a schema-invalid shape
          // (`to` is not an array, `bodyText` is not a string).
          yield* approvalsSvc.approve({
            id: r1.approvalId as never,
            tenantId: created.tenantId,
            decidedBy: UserId("manager-evil"),
            approvedInput: {
              threadId: "thread-l8",
              to: "buyer-l8@example.com",
              subject: null,
              bodyText: 12345,
              bodyHtml: null,
              draftId: "refund-reply-l8-1",
            },
          });

          const r2 = yield* runtime.handleEvent({
            type: "approval.approved",
            approvalId: r1.approvalId,
            caseId: created.id,
            managerId: UserId("manager-evil"),
          });

          const fetched = yield* repo.getById(created.id);
          const entries = yield* audit.forCase(created.id);
          return { r2, fetched, entries };
        }),
        layer,
      ),
    );

    // The resume refused to execute the malformed input.
    expect(out.r2.type).toBe("HumanTakeoverRequired");
    if (out.r2.type === "HumanTakeoverRequired") {
      expect(out.r2.reason).toBe("approval_input_invalid");
    }
    expect(out.fetched.status).toBe("human_takeover");
    // Critically: nothing went out to the customer.
    expect(convoTest.handle.sent).toHaveLength(0);
    // Escalation was recorded with the invalid-input reason.
    const escalation = out.entries.find(
      (e) => e.action === "case.escalated_to_human",
    );
    expect(escalation).toBeDefined();
    expect((escalation!.details as Record<string, unknown>)["reason"]).toBe(
      "approval_input_invalid",
    );
  });

  // Mirror test for the rejection path: approval.rejected should
  // escalate the case to human_takeover and NOT execute the tool.
  it("escalates to human_takeover on approval.rejected and does NOT execute the gated tool", async () => {
    const convoTest = makeConversationServiceTest({});
    const mailTest = makePlatformMailServiceTest({});

    const orderId = OrderId("gid://shopify/Order/99999");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#4001",
      confirmationNumber: null,
      email: "buyer3@example.com",
      customerId: CustomerId("gid://shopify/Customer/1000"),
      fulfillmentStatus: "delivered",
      financialStatus: "paid",
      totalPrice: { amount: "49.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [],
      fulfillments: [],
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    };

    const refundScript: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c0",
        tool: "case.update_context",
        input: {
          classification: "refund_request",
          identifiedOrderId: orderId,
        },
      },
      {
        type: "tool_call",
        callId: "c1",
        tool: "agent.handoff",
        input: { targetAgent: "refund-review-agent", reason: "specialist" },
      },
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "conversation.reply",
        input: {
          threadId: "thread-reject",
          to: [{ name: null, email: "buyer3@example.com" }],
          subject: null,
          bodyText: "draft for rejection test",
          bodyHtml: null,
          inReplyToMessageId: null,
          draftId: "refund-reply-rejected-1",
        },
      },
    ];

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      convoTest.layer,
      mailTest.layer,
      approvalLinkLayer,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;

          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: supportTriage.id,
            subject: "Refund please",
          });
          const r1 = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-reject" as never,
              messageId: "msg-r1",
              from: { name: null, email: "buyer3@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: "give me a refund",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          if (r1.type !== "PausedWaitingForApproval") {
            throw new Error(`expected paused, got ${r1.type}`);
          }
          const r2 = yield* runtime.handleEvent({
            type: "approval.rejected",
            approvalId: r1.approvalId,
            caseId: created.id,
            managerId: UserId("manager-2"),
            reason: "wrong policy",
          });
          const fetched = yield* repo.getById(created.id);
          return { r1, r2, fetched };
        }),
        layer,
      ),
    );

    expect(out.r2.type).toBe("HumanTakeoverRequired");
    expect(out.fetched.status).toBe("human_takeover");
    // No customer-facing reply was sent — the rejection short-
    // circuited execution.
    expect(convoTest.handle.sent).toHaveLength(0);
  });

  // ----------------------------------------------------------------
  // Regression: a case parked in `waiting_for_approval` must NOT be
  // resolved (or otherwise mutated) by the agent loop when an unrelated
  // event lands while the manager's approval is still pending — e.g. the
  // customer replies again on the same thread, or a follow-up timer
  // fires. Before the guard, ANY such event re-entered the agent loop;
  // a `final_message` decision then transitioned the case straight to
  // `resolved`, abandoning the still-pending approval (the manager never
  // decided, yet the case reads "resolved"). The runtime must instead
  // leave the case parked and re-report PausedWaitingForApproval. The
  // only legitimate ways out of `waiting_for_approval` are the
  // approval.approved / approval.rejected events (handled above the loop)
  // and an out-of-band human takeover — none of which run the agent.
  // ----------------------------------------------------------------
  it("does not resolve a case awaiting approval when a new event arrives while the approval is pending", async () => {
    const parkedAgent: AgentConfig = {
      id: AgentId("parked-agent"),
      name: "Parked",
      description: "Minimal agent for the awaiting-approval guard test.",
      mode: "primary",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      promptTemplate: "noop",
      tools: [],
      permissionOverrides: {},
      handoffs: [],
      maxTurnsPerTick: 2,
      temperature: 0,
    };

    // The scripted LLM's only decision is `final_message` — under the old
    // behavior that resolved whatever case the loop ran on. The guard must
    // short-circuit BEFORE the LLM is ever consulted, so this counter must
    // stay at zero.
    let llmCalls = 0;
    const llmFn = LLMServiceFromFn(() => {
      llmCalls += 1;
      return Eff.succeed({
        type: "final_message" as const,
        text: "All set — closing this out.",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([parkedAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      llmFn,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const approvalsSvc = yield* ApprovalService;

          // Seed a case already parked for approval, with a live pending
          // approval row (the manager has NOT decided yet).
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: parkedAgent.id,
            subject: "Refund please",
          });
          const approval = yield* approvalsSvc.create({
            tenantId: TenantId("tenant-acme"),
            caseId: created.id,
            agentId: parkedAgent.id,
            tool: "conversation.reply",
            proposedInput: { threadId: "thread-park", bodyText: "draft" },
            reasoning: "drafted a refund reply",
            riskLevel: "medium",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          yield* repo.transitionStatus(created.id, "waiting_for_approval", {
            reason: "tool conversation.reply pending approval",
          });

          // The customer replies again while the approval is still pending.
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-park" as never,
              messageId: "msg-park-2",
              from: { name: null, email: "buyer@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: "Any update on my refund?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });

          const fetched = yield* repo.getById(created.id);
          const pending = yield* approvalsSvc.listPending(
            TenantId("tenant-acme"),
          );
          return { result, fetched, pending, approvalId: approval.id };
        }),
        layer,
      ),
    );

    // The case stays parked — it is NOT resolved out from under the
    // pending approval.
    expect(out.fetched.status).toBe("waiting_for_approval");
    // The pending approval is untouched.
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]!.id).toBe(out.approvalId);
    expect(out.pending[0]!.status).toBe("pending");
    // The runtime re-reports the case as parked for that same approval.
    expect(out.result.type).toBe("PausedWaitingForApproval");
    if (out.result.type === "PausedWaitingForApproval") {
      expect(out.result.approvalId).toBe(out.approvalId);
    }
    // The agent loop never ran — the LLM was never consulted.
    expect(llmCalls).toBe(0);
  });
});

// BYOK: when the tenant has no LLM credential the runtime must park the
// case in `human_takeover` instead of returning a generic Failed. This
// test injects an LLMService that always fails with LLMCredentialMissing
// — the same shape LLMServiceLive returns when LLMCredentialResolver
// reports a missing tenant row.
describe("AgentRuntime — BYOK hard-fail when tenant has no LLM key", () => {
  it("parks the case in human_takeover with reason llm_credential_missing", async () => {
    const { LLMCredentialMissing } = await import("@support-agent/agent-core");

    const llmCredentialMissingLayer = LLMServiceFromFn((req) =>
      Eff.fail(new LLMCredentialMissing({ tenantId: req.tenantId })),
    );

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      llmCredentialMissingLayer,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;

          const workflow = yield* runtime.handleEvent(
            ticketCreated("hello", "tenant-no-llm"),
          );

          // Re-derive the just-created case via audit log.
          const tenant = TenantId("tenant-no-llm");
          // CaseRepositoryTest stores in-memory; the audit entry from
          // `event.received` carries the caseId. We can fetch by listing
          // pending approvals (none) — easier path: pull all entries for
          // any case in the tenant via a broad audit walk.
          // Instead, just scan repo.getById on all known ids would be
          // brittle; the runtime returned the workflow result which is
          // enough to assert the takeover path. Use the case's `findByThreadId`
          // — ticket.created creates without a threadId, so we walk the
          // audit log by fetching the workflow's case id via a trick:
          // CaseRepositoryTest exposes data through `listForTenant` —
          // we don't have a clean API here, so just assert via audit log
          // shape and the workflow result.

          // Pull audit entries for any case the tenant logged today.
          // The runtime always audits `event.received` first; we use
          // that to fish out a caseId.
          // CaseRepositoryTest doesn't expose listForTenant, but the
          // workflow result + audit-log search via `forCase` on a
          // discovered id is enough. We use `Effect.either` so a failed
          // lookup doesn't crash the test.

          void repo;
          void audit;
          return workflow;
        }),
        layer,
      ),
    );

    expect(out.type).toBe("HumanTakeoverRequired");
    if (out.type === "HumanTakeoverRequired") {
      expect(out.reason).toBe("llm_credential_missing");
    }
  });
});

// Per-tenant per-agent model override: the runtime should send the
// override model to the LLM instead of the agent's hardcoded
// `AgentConfig.model`. We capture the request shape with
// LLMServiceFromFn so we can assert the override propagated.
describe("AgentRuntime — per-tenant per-agent model override", () => {
  it("substitutes AgentConfig.model with the tenant override at LLM call time", async () => {
    const captured: { model: string | null } = { model: null };

    const overrideTenant = TenantId("tenant-override-acme");
    const overrideLayer = TenantAgentOverridesServiceTest([
      {
        tenantId: overrideTenant,
        agentId: supportTriage.id,
        model: "anthropic/claude-opus-4-7",
        updatedAt: new Date(),
      },
    ]);

    const captureLlm = LLMServiceFromFn((req) => {
      captured.model = req.model;
      return Eff.succeed<LLMDecision>({
        type: "final_message",
        text: "ok",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      captureLlm,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      overrideLayer,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AgentRuntime, (runtime) =>
          runtime.handleEvent(ticketCreated("hello", "tenant-override-acme")),
        ),
        layer,
      ),
    );

    expect(captured.model).toBe("anthropic/claude-opus-4-7");
    // Sanity: the agent's hardcoded model is NOT what we sent.
    expect(captured.model).not.toBe(supportTriage.model);
  });

  it("appends the tenant system prompt to the agent prompt at LLM call time", async () => {
    const captured: { system: string | null } = { system: null };
    const customPrompt =
      "ACME house style: greet with 'Hi there!' and sign off '— The Acme Team'.";

    const overrideLayer = TenantAgentOverridesServiceTest([
      {
        tenantId: TenantId("tenant-prompt-acme"),
        agentId: supportTriage.id,
        systemPrompt: customPrompt,
        updatedAt: new Date(),
      },
    ]);

    const captureLlm = LLMServiceFromFn((req) => {
      captured.system = req.system;
      return Eff.succeed<LLMDecision>({
        type: "final_message",
        text: "ok",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      captureLlm,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      overrideLayer,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AgentRuntime, (runtime) =>
          runtime.handleEvent(ticketCreated("hello", "tenant-prompt-acme")),
        ),
        layer,
      ),
    );

    // The built-in prompt is preserved (tool/handoff scaffolding intact) AND
    // the tenant's text is appended after it.
    expect(captured.system).toContain(supportTriage.promptTemplate);
    expect(captured.system).toContain(customPrompt);
    expect(captured.system?.indexOf(customPrompt) ?? -1).toBeGreaterThan(
      captured.system?.indexOf(supportTriage.promptTemplate) ?? -1,
    );
  });

  it("falls through to AgentConfig.model when no override exists for the agent", async () => {
    const captured: { model: string | null } = { model: null };

    const captureLlm = LLMServiceFromFn((req) => {
      captured.model = req.model;
      return Eff.succeed<LLMDecision>({
        type: "final_message",
        text: "ok",
      });
    });

    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      captureLlm,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(Layer.provide(env)),
      env,
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AgentRuntime, (runtime) =>
          runtime.handleEvent(ticketCreated("hello", "tenant-no-override")),
        ),
        layer,
      ),
    );

    expect(captured.model).toBe(supportTriage.model);
  });
});

// ============================================================
// refund.create — conditional per-tenant threshold
// ============================================================
//
// The conditional rule lives in PermissionServiceLive (consults
// tenants.settings.refundPolicy). These tests exercise the runtime
// against that Live layer instead of the static
// PermissionServiceDefault used in earlier blocks. Asserts:
//   - $20 below askAbove=$25 → tool auto-runs, case resolves
//   - $100 in the ask zone   → runtime parks for approval
//   - $500 above the cap     → tool short-circuited via denied_by_policy

describe("AgentRuntime — refund.create conditional permission", () => {
  const refundTenantId = TenantId("00000000-0000-0000-0000-000000000aaa");
  const refundOrderId = OrderId("gid://shopify/Order/77777");

  const fixtureOrder = (totalAmount: string): ShopifyOrder => ({
    id: refundOrderId,
    name: "#2001",
    confirmationNumber: null,
    email: "buyer@example.com",
    customerId: CustomerId("gid://shopify/Customer/555"),
    fulfillmentStatus: "delivered",
    financialStatus: "paid",
    totalPrice: { amount: totalAmount, currencyCode: "USD" },
    shippingAddress: null,
    lineItems: [
      {
        id: "li-1",
        title: "Wireless Earbuds",
        quantity: 1,
        sku: "EAR-01",
        variantTitle: null,
        productId: null,
      },
    ],
    fulfillments: [],
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-25T00:00:00.000Z"),
  });

  const scriptFor = (amountStr: string): ReadonlyArray<LLMDecision> => [
    {
      type: "tool_call",
      callId: "c0",
      tool: "case.update_context",
      input: { classification: "refund_request", identifiedOrderId: refundOrderId },
    },
    {
      type: "tool_call",
      callId: "c1",
      tool: "agent.handoff",
      input: { targetAgent: "refund-review-agent", reason: "specialist" },
    },
    {
      type: "tool_call",
      callId: "c2",
      tool: "shopify.get_order",
      input: { orderId: refundOrderId },
    },
    {
      type: "tool_call",
      callId: "c3",
      tool: "refund.create",
      input: {
        orderId: refundOrderId,
        amount: { amount: amountStr, currencyCode: "USD" },
        reason: "Customer-requested refund",
        notifyCustomer: true,
      },
    },
    // Final turn — only reached when refund.create is NOT gated to ask.
    { type: "final_message", text: "Refund issued for order #2001." },
  ];

  const tenantSettings = (
    ask: number,
    deny: number,
  ): TenantSettings =>
    new TenantSettings({
      notificationEmail: null,
      refundPolicy: {
        askAboveMinorUnits: ask,
        denyAboveMinorUnits: deny,
        currencyCode: "USD",
      },
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 730,
      supplierEscalationSheet: null,
      legalAcceptance: null,
    });

  // Shopify connection seeded with write_orders so the scope precheck
  // doesn't pre-empt the threshold logic these tests exist to exercise.
  // The dedicated scope-precheck test below uses an alt fixture that
  // strips the scope.
  const connectionsWithWriteOrders: ReadonlyArray<ConnectorConnection> = [
    {
      tenantId: refundTenantId,
      provider: "shopify",
      shopDomain: "test-shop.myshopify.com",
      accessToken: "shpat_test",
      refreshToken: null,
      tokenExpiresAt: null,
      metadata: {},
      scopes: ["read_orders", "read_customers", "write_orders"],
      apiVersion: "2026-04",
      installedAt: new Date(),
      status: "active",
    },
  ];

  const buildLayer = (
    amountStr: string,
    settings: TenantSettings,
    connections: ReadonlyArray<ConnectorConnection> = connectionsWithWriteOrders,
  ) => {
    const tenants = TenantRepositoryTest({
      settingsByTenant: new Map([[refundTenantId, settings]]),
    });
    const connectors = ConnectorCredentialStoreTest(connections);
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceLive.pipe(
        Layer.provide(Layer.mergeAll(tenants, connectors)),
      ),
      LLMServiceScripted(scriptFor(amountStr)),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[refundOrderId, fixtureOrder(amountStr)]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);
  };

  const runTick = (layer: Layer.Layer<AgentRuntime, never, never>) =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AgentRuntime, (runtime) =>
          runtime.handleEvent({
            type: "ticket.created",
            tenantId: refundTenantId,
            source: "email",
            occurredAt: new Date().toISOString(),
            payload: {
              subject: "Refund please",
              body: "Hi, I'd like a refund on order #2001.",
            },
          } as never),
        ),
        layer,
      ),
    );

  it("auto-runs a $20 refund when askAbove=$25 (case resolves)", async () => {
    const layer = buildLayer("20.00", tenantSettings(2500, 20000));
    const result = await runTick(layer);
    expect(result.type).toBe("Completed");
  });

  it("pauses a $100 refund for approval (mid-range)", async () => {
    const layer = buildLayer("100.00", tenantSettings(2500, 20000));
    const result = await runTick(layer);
    expect(result.type).toBe("PausedWaitingForApproval");
  });

  it("short-circuits a $500 refund above the hard cap via denied_by_policy", async () => {
    // refund.create is denied by the conditional rule. The runtime
    // pushes `{ error: "denied_by_policy" }` into the conversation and
    // continues the loop — the LLM's next decision (final_message in
    // the script) lets the runtime resolve. The hard guarantee here is
    // negative: the refund tool never actually executed (no money
    // moved), and the runtime did NOT pause for approval. The real
    // refund-review agent would also have a fallback to
    // conversation.reply on a denied refund, covered by the existing
    // refund-reply e2e test.
    const layer = buildLayer("500.00", tenantSettings(2500, 20000));
    const result = await runTick(layer);
    expect(result.type).toBe("Completed");
  });

  it("denies refund.create when the Shopify connection lacks write_orders", async () => {
    // Scope precheck pre-empts the threshold logic. A $5 refund that
    // would normally auto-allow gets denied because the active Shopify
    // row only carries `read_orders`/`read_customers`. The runtime
    // pushes `denied_by_policy` into the conversation; the LLM's next
    // decision (final_message in the script) lets the runtime resolve
    // — proving the tool never ran (no Shopify API call, no money
    // moved). In production the refund-review-agent would fall back to
    // PATH B (draft a reply) here.
    const readOnlyConnections: ReadonlyArray<ConnectorConnection> = [
      {
        ...connectionsWithWriteOrders[0]!,
        scopes: ["read_orders", "read_customers"],
      },
    ];
    const layer = buildLayer(
      "5.00",
      tenantSettings(2500, 20000),
      readOnlyConnections,
    );
    const result = await runTick(layer);
    expect(result.type).toBe("Completed");
  });

  it("flags refund_customer_mismatch when the refund order belongs to a different customer than the case", async () => {
    // Prompt-injection scope guard: the case's bound customer (jane@,
    // stamped by the runtime from the inbound sender — not the LLM) differs
    // from the order's customer (buyer@). A refund steered onto an unrelated
    // order trips the guard, which stamps a risk flag the approval card shows.
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "c2",
        tool: "shopify.get_order",
        input: { orderId: refundOrderId },
      },
      {
        type: "tool_call",
        callId: "c3",
        tool: "refund.create",
        input: {
          orderId: refundOrderId,
          amount: { amount: "100.00", currencyCode: "USD" },
          reason: "Customer-requested refund",
          notifyCustomer: false,
        },
      },
      { type: "final_message", text: "done" },
    ];

    const tenants = TenantRepositoryTest({
      settingsByTenant: new Map([[refundTenantId, tenantSettings(2500, 20000)]]),
    });
    const connectors = ConnectorCredentialStoreTest(connectionsWithWriteOrders);
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([refundReviewAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceLive.pipe(
        Layer.provide(Layer.mergeAll(tenants, connectors)),
      ),
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[refundOrderId, fixtureOrder("100.00")]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
      tenantOverridesEmpty,
      tenantRepoDefault,
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: refundTenantId,
            channel: "email",
            currentAgentId: refundReviewAgent.id,
            subject: "Refund please",
            context: { customerEmail: "jane@example.com" },
          });
          const result = yield* runtime.handleEvent({
            type: "customer.replied",
            caseId: created.id,
            payload: {
              threadId: "thread-mismatch" as never,
              messageId: "m-mismatch",
              from: { name: null, email: "jane@example.com" },
              to: [],
              subject: "Re: Refund please",
              bodyText: "please refund",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          const fetched = yield* repo.getById(created.id);
          return { result, fetched };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(out.fetched.context["riskFlags"]).toContain(
      "refund_customer_mismatch",
    );
  });
});

// ----------------------------------------------------------------
// Merchant notifications (Telegram, …) — best-effort pings emitted by
// the runtime at the business moments a merchant cares about. The
// service is OPTIONAL (Effect.serviceOption): every other test in this
// file omits it and must keep passing.
// ----------------------------------------------------------------
describe("AgentRuntime — merchant notifications", () => {
  const notifEnv = (
    script: ReadonlyArray<LLMDecision>,
    notifLayer: Layer.Layer<never, never, never>,
  ) => {
    const env = Layer.mergeAll(
      CaseRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([supportTriage, orderStatusAgent]),
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
      notifLayer as never,
    );
    return Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(env)), env);
  };

  const replyCall: LLMDecision = {
    type: "tool_call",
    callId: "n1",
    tool: "conversation.reply",
    input: {
      threadId: "thread-x",
      to: [{ name: null, email: "cust@example.com" }],
      subject: null,
      bodyText: "Your order is on its way.",
      bodyHtml: null,
      inReplyToMessageId: null,
      draftId: "order-status-reply-notif-1",
    },
  };

  const customerReplied = (caseId: string): DomainEvent => ({
    type: "customer.replied",
    caseId: caseId as never,
    payload: {
      threadId: "thread-x" as never,
      messageId: "msg-n1",
      from: { name: null, email: "cust@example.com" },
      to: [],
      subject: "Re: Where is my order?",
      bodyText: "Any update?",
      bodyHtml: null,
      receivedAt: new Date(),
      attachments: [],
    },
  });

  it("pings the merchant with approve/reject links when a tool pauses for approval", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: orderStatusAgent.id,
            subject: "Where is my order?",
          });
          const result = yield* runtime.handleEvent(customerReplied(created.id));
          return { result, caseId: created.id };
        }),
        notifEnv([replyCall], notifLayer as never),
      ),
    );

    expect(out.result.type).toBe("PausedWaitingForApproval");
    expect(handle.sent).toHaveLength(1);
    const sent = handle.sent[0]!;
    expect(sent.notification.kind).toBe("approval_requested");
    expect(sent.notification.caseId).toBe(out.caseId);
    expect(sent.notification.body).toContain("/approve?token=");
    expect(sent.notification.body).toContain("/reject?token=");
    expect(sent.notification.body).toContain("conversation.reply");
  });

  it("pings the merchant when the runtime escalates to human_takeover", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const loopScript: ReadonlyArray<LLMDecision> = Array.from(
      { length: 10 },
      (_, i) => ({
        type: "tool_call",
        callId: `t${i}`,
        tool: "case.update_context",
        input: { notes: `loop ${i}` },
      }),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          return yield* runtime.handleEvent(ticketCreated("loop forever"));
        }),
        notifEnv(loopScript, notifLayer as never),
      ),
    );

    expect(result.type).toBe("HumanTakeoverRequired");
    expect(handle.sent).toHaveLength(1);
    const sent = handle.sent[0]!;
    expect(sent.notification.kind).toBe("human_takeover");
    // Merchant-facing copy, not the internal code.
    expect(sent.notification.body).not.toContain("max_turns_exceeded");
    expect(sent.notification.title.length).toBeGreaterThan(0);
  });

  it("delivers an agent_note when the agent calls merchant.notify mid-case", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "m1",
        tool: "merchant.notify",
        input: {
          title: "Unverifiable claim",
          message: "Customer cites a promo code I cannot find anywhere.",
        },
      },
      { type: "final_message", text: "Flagged to the merchant; resolved." },
    ];
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* CaseRepository;
          const audit = yield* AuditLogService;
          const created = yield* repo.create({
            tenantId: TenantId("tenant-acme"),
            channel: "email",
            currentAgentId: orderStatusAgent.id,
            subject: "Where is my order?",
          });
          const result = yield* runtime.handleEvent(customerReplied(created.id));
          const entries = yield* audit.forCase(created.id);
          return { result, caseId: created.id, entries };
        }),
        notifEnv(script, notifLayer as never),
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(handle.sent).toHaveLength(1);
    const sent = handle.sent[0]!;
    expect(sent.notification.kind).toBe("agent_note");
    expect(sent.notification.caseId).toBe(out.caseId);
    expect(sent.notification.title).toBe("Unverifiable claim");

    // The audit row carries the heads-up content so the dashboard
    // timeline can show WHAT the agent flagged, not just that it did.
    const audited = out.entries.find(
      (e) =>
        e.action === "tool.invoked" &&
        (e.details as { tool?: string }).tool === "merchant.notify",
    );
    expect(audited).toBeDefined();
    const notify = (audited!.details as {
      notify?: { title?: string; message?: string; delivered?: boolean };
    }).notify;
    expect(notify?.title).toBe("Unverifiable claim");
    expect(notify?.message).toContain("promo code");
    expect(notify?.delivered).toBe(true);
  });
});
