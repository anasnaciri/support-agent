# Building This Support Agent

This tutorial explains how to build the agent architecture used in this repo. It is not a prompt-only chatbot. It is an event-driven support operations runtime: external events create or resume durable cases, agents decide what should happen next, tools perform typed side effects, and the runtime enforces permission and approval policy before anything risky happens.

The core idea is:

```text
event -> case -> agent config -> LLM decision -> permission check -> tool / approval / handoff -> audit
```

## 1. Start With The System Shape

The architecture is described in [`master-plan.md`](../master-plan.md). The product is the runtime around the model, not a single LLM prompt.

The repo is split into a few important layers:

- `packages/agent-core`: shared types and contracts.
- `packages/agents`: agent configs, prompts, tool lists, and handoff rules.
- `packages/tools`: typed tools the model is allowed to request.
- `packages/services`: abstract service tags and runtime orchestration.
- `packages/providers`: live integrations, including LLM, Shopify, Gmail, and mail.
- `packages/db`: Drizzle schema and Postgres-backed service implementations.
- `apps/worker`: queue consumer that runs the agent runtime.
- `apps/api`: webhook and OAuth edge.
- `apps/dashboard`: manager UI for cases, approvals, settings, and audit.

## 2. Define The Core Contracts

The agent runtime is built around three core contracts.

`AgentConfig` lives in [`packages/agent-core/src/agent.ts`](../packages/agent-core/src/agent.ts). An agent is configuration:

- `id`
- `name`
- `mode`
- `provider`
- `model`
- `promptTemplate`
- `tools`
- `permissionOverrides`
- `handoffs`
- `maxTurnsPerTick`
- `temperature`

A minimal agent config looks like this:

```ts
import { AgentId, type AgentConfig } from "@support-agent/agent-core";

export const supportTriage: AgentConfig = {
  id: AgentId("support-triage"),
  name: "Support Triage",
  description: "Classifies inbound support tickets and routes them.",
  mode: "primary",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: [
    "You are a support-triage agent for an ecommerce store.",
    "Classify the customer message, record the classification, then hand off if needed.",
  ].join("\n"),
  tools: ["case.update_context", "agent.handoff"],
  permissionOverrides: {},
  handoffs: [AgentId("order-status-agent"), AgentId("refund-review-agent")],
  maxTurnsPerTick: 4,
  temperature: 0,
};
```

`Tool` lives in [`packages/agent-core/src/tool.ts`](../packages/agent-core/src/tool.ts). A tool declares:

- input schema
- output schema
- risk level
- default permission
- side-effect class
- optional idempotency key
- executable Effect body

`DomainEvent` lives in [`packages/agent-core/src/event.ts`](../packages/agent-core/src/event.ts). Events are what wake the agent:

- `message.received`
- `ticket.created`
- `approval.approved`
- `approval.rejected`
- `customer.replied`
- `timer.expired`
- other workflow events

A normalized inbound message event looks like this:

```ts
import {
  TenantId,
  ThreadId,
  type DomainEvent,
} from "@support-agent/agent-core";

const event: DomainEvent = {
  type: "message.received",
  tenantId: TenantId("6d9c16fd-0b9e-4d2b-a1d4-01ed4d1e5f11"),
  threadId: ThreadId("gmail-thread-123"),
  payload: {
    threadId: ThreadId("gmail-thread-123"),
    messageId: "gmail-message-456",
    subject: "Where is order #1001?",
    bodyText: "Hi, can you tell me where order #1001 is?",
    bodyHtml: null,
    from: { name: "Ada Lovelace", email: "ada@example.com" },
    to: [{ name: null, email: "support@example.com" }],
    receivedAt: new Date(),
    attachments: [],
  },
};
```

These contracts keep the model boxed in. The model can ask for tools, but the runtime decides whether those tools are valid, allowed, denied, or require approval.

## 3. Create Durable Case State

The durable state lives in the Drizzle schema in [`packages/db/src/schema.ts`](../packages/db/src/schema.ts).

The important tables are:

- `tenants`: merchant/account boundary.
- `cases`: durable unit of work for the agent.
- `case_state_transitions`: status history.
- `audit_log`: every major event, model decision, and tool invocation.
- `approvals`: pending and decided human approval requests.
- `connector_connections`: encrypted Shopify, Gmail, and LLM credentials.
- `tenant_agent_overrides`: per-tenant model overrides.

The key design choice is that the case is the unit of work. The agent does not hold a long-running chat process in memory. A worker receives an event, loads or creates a case, runs a bounded agent tick, persists the result, and exits.

## 4. Build Typed Tools

Tools are declared in `packages/tools` with `defineTool`.

A simple example is [`packages/tools/src/case/update-context.ts`](../packages/tools/src/case/update-context.ts). It shallow-merges derived facts into the case context, such as classification, order id, customer id, and notes.

A higher-risk example is [`packages/tools/src/conversation/reply.ts`](../packages/tools/src/conversation/reply.ts). It sends a customer-facing reply through the conversation connector. Its `defaultPermission` is `ask`, so the runtime creates an approval instead of sending immediately.

Here is a simplified tool declaration in the same style as `case.update_context`:

```ts
import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { CaseRepository } from "@support-agent/services";

const Input = Schema.Struct({
  classification: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
});

const Output = Schema.Struct({
  caseId: Schema.String,
  contextKeys: Schema.Array(Schema.String),
});

export const caseUpdateContext = defineTool({
  name: "case.update_context",
  description: "Merge derived facts into the case context.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "write",
  defaultPermission: "allow",
  sideEffectClass: "external_state",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const repo = yield* CaseRepository;
      const current = yield* repo.getById(ctx.caseId).pipe(
        Effect.mapError(
          (e) =>
            new ToolOutputInvalid({
              tool: "case.update_context",
              issues: [e._tag],
            }),
        ),
      );

      const nextContext = {
        ...current.context,
        ...(input.classification
          ? { classification: input.classification }
          : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      };

      const updated = yield* repo
        .update(ctx.caseId, { context: nextContext })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "case.update_context",
                issues: [e._tag],
              }),
          ),
        );

      return {
        caseId: updated.id,
        contextKeys: Object.keys(updated.context),
      };
    }),
});
```

Here is the important difference for a customer-facing tool:

```ts
// ReplyInput and ReplyOutput are Effect schemas from conversation/reply.ts.
export const conversationReply = defineTool({
  name: "conversation.reply",
  description: "Send a customer-facing reply on an existing thread.",
  inputSchema: ReplyInput,
  outputSchema: ReplyOutput,
  risk: "communicate",
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  idempotencyKey: (input) => input.draftId,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const conversation = yield* ConversationService;
      return yield* conversation.reply(ctx.tenantId, input);
    }),
});
```

The tutorial pattern for each new tool is:

1. Define an Effect `Schema` for input.
2. Define an Effect `Schema` for output.
3. Pick a `risk`: `read`, `write`, `communicate`, or `money`.
4. Pick a `defaultPermission`: `allow`, `ask`, or `deny`.
5. Pick a `sideEffectClass`.
6. Implement `execute(input, ctx)` through service tags, not direct infrastructure imports.
7. Export the tool from [`packages/tools/src/index.ts`](../packages/tools/src/index.ts).
8. Register it in the worker bootstrap.

## 5. Write The First Agent

The first agent is [`packages/agents/src/support-triage.ts`](../packages/agents/src/support-triage.ts).

It classifies inbound support messages into:

- `where_is_order`
- `missing_package`
- `damaged_product`
- `refund_request`
- `general_inquiry`

Its allowed tools are deliberately narrow:

```ts
tools: ["case.update_context", "agent.handoff"]
```

The prompt gives the model instructions, but the `tools` array is what actually limits capability:

```ts
export const supportTriage: AgentConfig = {
  // ...
  promptTemplate: [
    "Turn 1: call `case.update_context` once with the classification.",
    "Turn 2: call `agent.handoff` only when a specialist should handle it.",
    "Never send email. Never call Shopify.",
  ].join("\n"),
  tools: ["case.update_context", "agent.handoff"],
  handoffs: [AgentId("order-status-agent"), AgentId("refund-review-agent")],
};
```

That means triage can classify and route, but it cannot email customers, call Shopify, or issue refunds. This is the basic safety model: prompts describe intent, but tool lists define capability.

## 6. Add Specialist Agents

Specialist agents live next to triage in `packages/agents/src`.

`order-status-agent` handles `where_is_order` cases. It can call Shopify read tools and draft a customer reply, but the reply requires approval.

`refund-review-agent` handles `refund_request` cases. It can fetch the order, draft a reply, or call `refund.create`. The runtime applies tenant-specific refund thresholds before a refund is allowed.

The important pattern is that these are still config objects. There is no custom class per agent. The generic runtime interprets all agents the same way.

A specialist narrows the prompt but widens the tool list:

```ts
export const orderStatusAgent: AgentConfig = {
  id: AgentId("order-status-agent"),
  name: "Order Status",
  description: "Drafts order-status replies from Shopify order data.",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: [
    "Fetch the Shopify order.",
    "Draft a short customer-facing delivery-status reply.",
    "`conversation.reply` requires human approval, so the runtime will pause.",
  ].join("\n"),
  tools: ["shopify.get_order", "case.update_context", "conversation.reply"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 6,
  temperature: 0,
};
```

## 7. Register Agents And Tools

The worker registers the available agents and tools in [`apps/worker/src/bootstrap.ts`](../apps/worker/src/bootstrap.ts).

The agent registry is built with:

```ts
AgentRegistryWith([supportTriage, orderStatusAgent, refundReviewAgent])
```

The tool registry is built with:

```ts
ToolRegistryWith([
  caseUpdateContext,
  caseUpdateStatus,
  shopifyGetOrder,
  shopifyGetCustomer,
  shopifyRefundCreate,
  conversationFetchThread,
  conversationReply,
  conversationAskCustomer,
  agentHandoff,
])
```

If a tool is not registered, the model cannot use it even if a prompt mentions it.

## 8. Wire The LLM Service

The live LLM adapter is [`packages/providers/src/llm-service-live.ts`](../packages/providers/src/llm-service-live.ts).

It uses the Vercel AI SDK and supports tenant-supplied credentials through `LLMCredentialResolver`.

Its job is to:

1. Resolve the tenant's active LLM credential.
2. Build or reuse the provider adapter.
3. Convert internal chat messages to AI SDK messages.
4. Convert tool schemas to AI SDK tools.
5. Call `generateText`.
6. Map the result back to either a tool call or a final message.

The runtime owns the tool loop. The LLM service only performs one model call at a time.

At the provider boundary, the service turns internal tool schemas into AI SDK tools:

```ts
const result = yield* Effect.tryPromise({
  try: () =>
    generateText({
      model: factory(req),
      system: req.system,
      messages: toModelMessages(req.messages, sanitize),
      tools: toToolSet(req.tools, sanitize),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    }),
  catch: (cause) => mapError(cause, cred.provider),
});

const call = result.toolCalls[0];
if (call) {
  return {
    type: "tool_call",
    callId: call.toolCallId,
    tool: sanitize ? desanitize(call.toolName, reverseMap) : call.toolName,
    input: call.input,
  };
}

return { type: "final_message", text: result.text };
```

## 9. Implement The Runtime Loop

The core runtime is [`packages/services/src/agent-runtime.ts`](../packages/services/src/agent-runtime.ts).

For each event, it:

1. Converts the event into a case lookup.
2. Loads or creates the case.
3. Records `event.received` in the audit log.
4. Resolves the current agent.
5. Builds the initial messages.
6. Loads tool schemas for that agent.
7. Calls `LLMService.runToolCalling`.
8. Records the LLM decision.
9. Handles final messages, handoffs, tool calls, approvals, and denials.
10. Stops after the agent's `maxTurnsPerTick`.

Tool execution follows this order:

```text
LLM tool call
  -> find tool in ToolRegistry
  -> PermissionService.check(...)
  -> deny: return denied tool result to model
  -> ask: create approval and pause case
  -> allow: execute tool and audit result
```

In code, the hot path is roughly:

```ts
for (let turn = 0; turn < agent.maxTurnsPerTick; turn++) {
  const schemas = yield* tools.schemasFor(agent.tools);
  const decision = yield* llm.runToolCalling({
    tenantId: current.tenantId,
    model: agent.model,
    system: agent.promptTemplate,
    messages,
    tools: schemas,
    ...(agent.temperature !== undefined
      ? { temperature: agent.temperature }
      : {}),
  });

  yield* audit.record({
    tenantId: current.tenantId,
    caseId: current.id,
    actor: { type: "agent", id: agent.id },
    action: "llm.decision",
    details: { turn, decisionType: decision.type },
  });

  if (decision.type === "final_message") {
    yield* cases.transitionStatus(current.id, "resolved", {
      reason: "runtime: final_message",
    });
    return { type: "Completed" };
  }

  if (decision.type === "tool_call") {
    const tool = yield* tools.get(decision.tool);
    const permission = yield* perms.check({
      tenantId: current.tenantId,
      agent,
      tool,
      payload: decision.input,
    });

    if (permission === "ask") {
      const approval = yield* approvals.create({
        tenantId: current.tenantId,
        caseId: current.id,
        agentId: agent.id,
        tool: tool.name,
        proposedInput: decision.input,
        reasoning: decision.reasoning ?? "",
        riskLevel: "medium",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      return {
        type: "PausedWaitingForApproval",
        approvalId: approval.id,
      };
    }
  }
}
```

This is the security boundary. The model never directly talks to Shopify, Gmail, Postgres, or the customer.

## 10. Add Handoffs

`agent.handoff` is declared as a normal tool in [`packages/tools/src/agent/handoff.ts`](../packages/tools/src/agent/handoff.ts), but the runtime intercepts it.

When the model calls `agent.handoff`, the runtime:

1. Reads `targetAgent`.
2. Checks that the current agent's `handoffs` list allows that target.
3. Updates `cases.currentAgentId`.
4. Audits the handoff.
5. Pushes a tool result into the conversation.
6. Continues the tick with the target agent.

This lets triage delegate to specialists without giving triage broad capabilities.

The LLM sees handoff as a tool call:

```ts
{
  type: "tool_call",
  callId: "call_123",
  tool: "agent.handoff",
  input: {
    targetAgent: "order-status-agent",
    reason: "Customer asked for tracking on order #1001",
  },
}
```

The runtime checks the current agent config before honoring it:

```ts
const raw = decision.input as { readonly targetAgent?: unknown };
const target = typeof raw.targetAgent === "string" ? raw.targetAgent : null;
const allowed =
  target !== null && agent.handoffs.some((id) => (id as string) === target);

if (!allowed) {
  messages.push({
    role: "tool",
    toolCallId: decision.callId,
    toolName: "agent.handoff",
    content: {
      error: "target_not_in_handoffs",
      target,
      allowed: agent.handoffs,
    },
  });
}
```

## 11. Add Permission And Approval Policy

The live permission service is [`packages/services/src/permission-service-live.ts`](../packages/services/src/permission-service-live.ts).

The decision pipeline is:

```text
agent.permissionOverrides[tool.name] ?? tool.defaultPermission
  -> tenant conditional policy
  -> allow | ask | deny
```

For most tools, the static decision is enough. For `refund.create`, tenant refund policy can:

- allow small refunds automatically
- require approval for mid-range refunds
- deny refunds above the hard cap

The conditional refund rule is deliberately pure and testable:

```ts
export const applyRefundPolicy = (
  staticPermission: Permission,
  policy: RefundPolicy,
  amount: { amountMinorUnits: number; currencyCode: string } | null,
): Permission => {
  if (!amount) return staticPermission;

  if (amount.currencyCode !== policy.currencyCode.toUpperCase()) {
    return staticPermission === "deny" ? "deny" : "ask";
  }

  if (amount.amountMinorUnits > policy.denyAboveMinorUnits) {
    return "deny";
  }

  if (amount.amountMinorUnits <= policy.askAboveMinorUnits) {
    return staticPermission === "ask" ? "allow" : staticPermission;
  }

  return staticPermission === "deny" ? "deny" : "ask";
};
```

When permission is `ask`, the runtime creates an approval row, moves the case to `waiting_for_approval`, and sends an approval link if mail is configured.

## 12. Resume Approved Work

Approval events are handled specially in [`packages/services/src/agent-runtime.ts`](../packages/services/src/agent-runtime.ts).

For `approval.approved`, the runtime:

1. Loads the approval.
2. Finds the original tool.
3. Executes the approved input.
4. Audits the tool invocation with `viaApprovalId`.
5. Resolves the case.

For `approval.rejected`, the runtime moves the case to `human_takeover`.

This avoids asking the LLM to regenerate a previously approved action.

A simplified approval resume branch looks like this:

```ts
if (event.type === "approval.approved") {
  const approval = yield* approvals.getById(event.approvalId);
  const tool = yield* tools.get(approval.tool);

  const ctx: ToolContext = {
    tenantId: working.tenantId,
    caseId: working.id,
    agentId: approval.agentId,
    callId: `approval-${approval.id}`,
    attemptNumber: 1,
  };

  const input = approval.approvedInput ?? approval.proposedInput;
  const result = yield* tool.execute(input, ctx).pipe(Effect.either);

  yield* audit.record({
    tenantId: working.tenantId,
    caseId: working.id,
    actor: { type: "user", id: event.managerId },
    action: "tool.invoked",
    details: {
      tool: approval.tool,
      ok: result._tag === "Right",
      viaApprovalId: approval.id,
    },
  });
}
```

## 13. Compose Live Infrastructure

`apps/worker/src/bootstrap.ts` composes the live Effect layers:

- Postgres repositories
- transaction runner
- agent registry
- tool registry
- LLM provider
- Shopify provider
- conversation connector
- platform mail
- approval-link config
- permission policy

It also chooses live vs test implementations based on environment variables. For example, local development can use `OPENROUTER_API_KEY`, while production can resolve tenant BYOK credentials from `connector_connections`.

The final layer composition looks like this in miniature:

```ts
const registry = Layer.mergeAll(
  Layer.orDie(
    AgentRegistryWith([supportTriage, orderStatusAgent, refundReviewAgent]),
  ),
  Layer.orDie(
    ToolRegistryWith([
      caseUpdateContext as AnyTool,
      shopifyGetOrder as AnyTool,
      conversationReply as AnyTool,
      agentHandoff as AnyTool,
    ]),
  ),
  PermissionServiceLive.pipe(Layer.provide(TenantRepositoryLive)),
);

const env = Layer.mergeAll(
  repos,
  registry,
  llm,
  shopify,
  conversation,
  mail,
  approvalLinkLayer,
);

const envWithDb = env.pipe(Layer.provide(dbLayer));

const runtimeLayer = Layer.mergeAll(
  AgentRuntimeDefault.pipe(Layer.provide(envWithDb)),
  envWithDb,
  dbLayer,
);
```

## 14. Consume Workflow Events

The worker entry point is [`apps/worker/src/index.ts`](../apps/worker/src/index.ts).

It:

1. Builds the worker dependencies.
2. Ensures the `workflow.events` pg-boss queue exists.
3. Registers a pg-boss worker.
4. Revives the serialized domain event.
5. Calls `AgentRuntime.handleEvent(event)`.
6. Logs the workflow result.

The queue gives the runtime durable, retryable event processing.

The worker consumes a queued event like this:

```ts
const workerId = await boss.work(DEFAULT_WORKFLOW_QUEUE_NAME, async (jobs) => {
  for (const job of jobs) {
    const event = reviveDomainEvent(job.data.event);

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(AgentRuntime, (runtime) =>
          runtime.handleEvent(event),
        ),
        runtimeLayer,
      ),
    );

    if (!Exit.isSuccess(exit)) {
      throw new Error(`AgentRuntime crashed: ${Cause.pretty(exit.cause)}`);
    }
  }
});
```

## 15. Add HTTP And Connector Edges

The API app turns external HTTP events into domain events.

Examples:

- Shopify OAuth and webhooks live in `apps/api/src/shopify-*`.
- Gmail OAuth and Pub/Sub handling live in `apps/api/src/google-*` and `apps/api/src/gmail-webhook.ts`.
- Approval-link endpoints live in `apps/api/src/approval-endpoints.ts`.

The API should stay thin. It validates and normalizes external input, then publishes domain events. Business logic belongs in the runtime and services.

## 16. Add The Dashboard

The dashboard is a client of the runtime state.

It shows:

- today view
- case list
- case detail
- audit trail
- approvals
- settings
- integrations
- agent model overrides
- refund policy

The dashboard does not become the agent runtime. It reads from Postgres and sends commands, such as approve, reject, or take over.

## 17. Test Deterministically

Most agent behavior should be tested with scripted LLM decisions rather than live model calls.

Use:

- `LLMServiceScripted`
- `LLMServiceFromFn`
- test service layers
- runtime e2e tests under `apps/worker/test`

For example, script the model to classify a message, then finish:

```ts
const llm = LLMServiceScripted([
  {
    type: "tool_call",
    callId: "call-1",
    tool: "case.update_context",
    input: {
      classification: "where_is_order",
      identifiedOrderId: "#1001",
      notes: "Customer asked for shipping status.",
    },
  },
  {
    type: "final_message",
    text: "Triaged as where_is_order.",
  },
]);

const result = await Effect.runPromise(
  Effect.provide(
    Effect.flatMap(AgentRuntime, (runtime) =>
      runtime.handleEvent({
        type: "ticket.created",
        tenantId,
        source: "api",
        payload: {
          subject: "Order #1001",
          body: "Where is my order?",
          customerEmail: "ada@example.com",
          metadata: {},
        },
      }),
    ),
    testRuntimeLayer.pipe(Layer.provide(llm)),
  ),
);

expect(result.type).toBe("Completed");
```

The useful test cases are:

- triage updates case context
- triage hands off to the correct specialist
- unknown or disallowed tools do not execute
- `ask` creates an approval and pauses the case
- approved work executes exactly once
- rejected work moves to human takeover
- refund thresholds allow, ask, or deny correctly

## 18. Verify The Build

From the repo root:

```sh
pnpm build
pnpm test
```

For local end-to-end operation, the minimum moving parts are:

- Postgres
- pg-boss queue
- worker
- API app
- dashboard app
- LLM credential
- at least one conversation connector or test connector
- Shopify credentials if testing Shopify-backed workflows

## The Mental Model

The finished system works because each piece has a narrow responsibility:

- Events wake the system.
- Cases persist state.
- Agents choose the next action.
- Tools define what actions exist.
- Permission policy decides whether actions can run.
- Approvals pause risky actions.
- The runtime audits every meaningful step.
- The worker makes the whole process durable and retryable.

That is the agent in this repo: not a chatbot, but a typed, permissioned, auditable support operations runtime around an LLM.
