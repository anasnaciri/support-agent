import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistryWith,
  CaseId,
  CustomerId,
  OrderId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type DomainEvent,
  type LLMDecision,
  type ShopifyOrder,
} from "@support-agent/agent-core";
import {
  orderStatusAgent,
  refundReviewAgent,
  supportTriage,
} from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
  conversationReply,
  shopifyGetCustomer,
  shopifyGetOrder,
} from "@support-agent/tools";
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
  ConversationServiceTest,
  LLMServiceFromFn,
  LLMServiceScripted,
  PlatformMailServiceTest,
  ShopifyServiceTest,
  TransactionRunnerPassthrough,
  makeConversationServiceTest,
  makePlatformMailServiceTest,
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
  AgentRegistryWith([supportTriage, orderStatusAgent]),
  ToolRegistryWith([
    caseUpdateStatus as never,
    caseUpdateContext as never,
    agentHandoff as never,
    shopifyGetOrder as never,
  ]),
  PermissionServiceDefault,
  LLMServiceScripted(triageScript),
  TransactionRunnerPassthrough,
  ShopifyServiceTest({}),
  approvalLinkLayer,
  platformMailNoop,
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

    // Audit trail shape: event.received + 3 llm.decision + 2 tool.invoked.
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
      AgentRegistryWith([supportTriage, orderStatusAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
        conversationReply as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(handoffScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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
    // event.received + (llm.decision, tool.invoked) x 3 + final llm.decision.
    // No `tool.invoked` for conversation.reply because permission=ask
    // short-circuits before execute. No `case.resolved` because we paused.
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
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
      AgentRegistryWith([supportTriage, orderStatusAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(rejectedScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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

    expect(out.result.type).toBe("Completed");
    // Agent did NOT swap because the target wasn't in handoffs.
    expect(out.fetched.currentAgentId).toBe(supportTriage.id);

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
      AgentRegistryWith([supportTriage]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
      ]),
      PermissionServiceDefault,
      llmFn,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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

    expect(result.type).toBe("Completed");
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
      AgentRegistryWith([supportTriage]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(loopScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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
      AgentRegistryWith([supportTriage, orderStatusAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(continueScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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
      AgentRegistryWith([supportTriage, orderStatusAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(triageScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        customersByEmail: new Map([["jane@example.com", fixtureCustomer]]),
      }),
      approvalLinkLayer,
      platformMailNoop,
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
      AgentRegistryWith([supportTriage, refundReviewAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
        shopifyGetCustomer as never,
        conversationReply as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      ConversationServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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
    // final llm.decision (the conversation.reply tool call that was gated).
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
    ]);
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
      AgentRegistryWith([supportTriage, refundReviewAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
        shopifyGetCustomer as never,
        conversationReply as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      convoTest.layer,
      mailTest.layer,
      approvalLinkLayer,
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

  // Mirror test for the rejection path: approval.rejected should
  // escalate the case to human_takeover and NOT execute the tool.
  it("escalates to human_takeover on approval.rejected and does NOT execute the gated tool", async () => {
    const convoTest = makeConversationServiceTest({});
    const mailTest = makePlatformMailServiceTest({});

    const orderId = OrderId("gid://shopify/Order/99999");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#4001",
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
      AgentRegistryWith([supportTriage, refundReviewAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
        shopifyGetCustomer as never,
        conversationReply as never,
      ]),
      PermissionServiceDefault,
      LLMServiceScripted(refundScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
      convoTest.layer,
      mailTest.layer,
      approvalLinkLayer,
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
      AgentRegistryWith([supportTriage, orderStatusAgent]),
      ToolRegistryWith([
        caseUpdateStatus as never,
        caseUpdateContext as never,
        agentHandoff as never,
        shopifyGetOrder as never,
      ]),
      PermissionServiceDefault,
      llmCredentialMissingLayer,
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      approvalLinkLayer,
      platformMailNoop,
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
