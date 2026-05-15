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
import { orderStatusAgent, supportTriage } from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
  shopifyGetOrder,
} from "@support-agent/tools";
import {
  AgentRuntime,
  AgentRuntimeDefault,
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  CaseRepository,
  CaseRepositoryTest,
  LLMServiceScripted,
  ShopifyServiceTest,
  TransactionRunnerPassthrough,
} from "@support-agent/services";

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

  it("hands off from support-triage to order-status-agent and resolves via the specialist", async () => {
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
    // turn 3 — order-status-agent writes a final_message; runtime resolves
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
        type: "final_message",
        text: "Your order #1001 is in transit with UPS, tracking 1Z999; estimated delivery 2026-05-20.",
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
      LLMServiceScripted(handoffScript),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({
        orders: new Map([[orderId, fixtureOrder]]),
      }),
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
          return { result, fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.result.type).toBe("Completed");
    expect(out.fetched.status).toBe("resolved");
    // The handoff persisted the new agent on the case row.
    expect(out.fetched.currentAgentId).toBe(orderStatusAgent.id);
    expect(out.fetched.context["classification"]).toBe("where_is_order");
    expect(out.fetched.context["identifiedOrderId"]).toBe(orderId);

    const actions = out.entries.map((e) => e.action);
    // event.received + (llm.decision, tool.invoked) × 3 + final llm.decision +
    // case.resolved. The handoff is an audit row tagged tool.invoked from the
    // SOURCE agent's perspective; tool.invoked for shopify.get_order is from
    // the target's perspective.
    expect(actions).toEqual([
      "event.received",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "tool.invoked",
      "llm.decision",
      "case.resolved",
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
});
