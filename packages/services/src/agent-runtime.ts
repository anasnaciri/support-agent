import { Context, Effect, Layer } from "effect";
import {
  AgentRegistry,
  PermissionService,
  ToolRegistry,
  type AgentConfig,
  type AnyTool,
  type ApprovalRiskLevel,
  type CaseChannel,
  type ChatMessage,
  type DomainEvent,
  type LLMDecision,
  type ToolContext,
  type WorkflowResult,
  AgentId as makeAgentId,
} from "@support-agent/agent-core";
import { CaseRepository } from "./case-repository.js";
import { AuditLogService } from "./audit-log.js";
import { ApprovalService } from "./approval-service.js";
import { LLMService } from "./llm-service.js";
import { TransactionRunner } from "./transaction-runner.js";

// ============================================================
// Helpers
// ============================================================

type CaseLookup =
  | { readonly kind: "load"; readonly caseId: string }
  | {
      readonly kind: "create";
      readonly tenantId: string;
      readonly channel: CaseChannel;
      readonly subject: string | null;
      readonly initialUserMessage: string | null;
    };

const eventToCaseLookup = (event: DomainEvent): CaseLookup | null => {
  switch (event.type) {
    case "ticket.created":
      return {
        kind: "create",
        tenantId: event.tenantId,
        channel: event.source,
        subject: event.payload.subject,
        initialUserMessage: event.payload.body,
      };
    case "customer.replied":
    case "approval.approved":
    case "approval.rejected":
    case "supplier.updated":
    case "timer.expired":
    case "manual.takeover":
    case "case.resumed":
      return { kind: "load", caseId: event.caseId };
    case "email.received":
    case "tracking.changed":
      // Phase 1 does not implement lookup-by-thread / lookup-by-order.
      return null;
  }
};

const buildInitialMessages = (
  event: DomainEvent,
  caseSubject: string | null,
): ChatMessage[] => {
  if (event.type === "ticket.created") {
    const subject = event.payload.subject ?? caseSubject ?? "(no subject)";
    return [
      {
        role: "user",
        content: `Subject: ${subject}\n\n${event.payload.body}`,
      },
    ];
  }
  if (event.type === "customer.replied") {
    return [
      {
        role: "user",
        content: event.payload.bodyText ?? "(empty reply)",
      },
    ];
  }
  // Other events resume an in-flight case; for Phase 1 we don't have message
  // history, so we just signal what woke the case up.
  return [
    {
      role: "user",
      content: `(system event: ${event.type})`,
    },
  ];
};

const riskFor = (tool: AnyTool): ApprovalRiskLevel => {
  switch (tool.risk) {
    case "read":
      return "low";
    case "communicate":
    case "write":
      return "medium";
    case "money":
      return "high";
  }
};

// ============================================================
// Tag
// ============================================================

export class AgentRuntime extends Context.Tag("AgentRuntime")<
  AgentRuntime,
  {
    readonly handleEvent: (
      event: DomainEvent,
    ) => Effect.Effect<WorkflowResult, never>;
  }
>() {}

// ============================================================
// Default layer
// ============================================================

export const AgentRuntimeDefault = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const cases = yield* CaseRepository;
    const audit = yield* AuditLogService;
    const registry = yield* AgentRegistry;
    const tools = yield* ToolRegistry;
    const perms = yield* PermissionService;
    const approvals = yield* ApprovalService;
    const llm = yield* LLMService;
    const tx = yield* TransactionRunner;

    const tick = (event: DomainEvent): Effect.Effect<WorkflowResult, never> =>
      Effect.gen(function* () {
        const lookup = eventToCaseLookup(event);
        if (!lookup) {
          return {
            type: "Failed",
            reason: `event type ${event.type} not yet supported`,
            retryable: false,
          } as const;
        }

        // 1+2. Load/create case and audit event arrival in one tx
        // (master-plan §4 invariant: event → case write must be atomic
        // with audit). Subsequent per-turn writes happen outside this tx;
        // a fully transactional tick is deferred until we can scope an LLM
        // call outside the SQL tx without holding a connection open.
        const caseRow = yield* tx.run(
          Effect.gen(function* () {
            const row =
              lookup.kind === "load"
                ? yield* cases.getById(lookup.caseId as never)
                : yield* cases.create({
                    tenantId: lookup.tenantId as never,
                    channel: lookup.channel,
                    currentAgentId: makeAgentId("support-triage"),
                    subject: lookup.subject,
                  });
            yield* audit.record({
              tenantId: row.tenantId,
              caseId: row.id,
              actor: { type: "system", id: "runtime" },
              action: "event.received",
              details: { eventType: event.type },
            });
            return row;
          }),
        );

        // 3. Run the workflow loop.
        let agent: AgentConfig = yield* registry.resolve(caseRow.currentAgentId);
        const messages: ChatMessage[] = buildInitialMessages(
          event,
          caseRow.subject,
        );
        let current = caseRow;

        for (let turn = 0; turn < agent.maxTurnsPerTick; turn++) {
          const schemas = yield* tools.schemasFor(agent.tools);
          const decision: LLMDecision = yield* llm.runToolCalling({
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
            if (current.status !== "resolved") {
              // Wrap the final transition + a "case.resolved" audit in one
              // tx — keeps the resolved status and its audit row atomically
              // consistent (master-plan §4).
              current = yield* tx.run(
                Effect.gen(function* () {
                  const row = yield* cases.transitionStatus(
                    current.id,
                    "resolved",
                    { reason: "runtime: final_message" },
                  );
                  yield* audit.record({
                    tenantId: row.tenantId,
                    caseId: row.id,
                    actor: { type: "agent", id: agent.id },
                    action: "case.resolved",
                    details: { turn, finalMessage: decision.text },
                  });
                  return row;
                }),
              );
            }
            return { type: "Completed" } as const;
          }

          if (decision.type === "handoff") {
            agent = yield* registry.resolve(decision.targetAgent);
            current = yield* cases.update(current.id, {
              currentAgentId: decision.targetAgent,
            });
            continue;
          }

          if (decision.type === "wait_for_customer") {
            return {
              type: "HumanTakeoverRequired",
              reason: "wait_for_customer not wired in Phase 1",
            } as const;
          }

          if (decision.type === "escalate_supplier") {
            return {
              type: "HumanTakeoverRequired",
              reason: "escalate_supplier not wired in Phase 1",
            } as const;
          }

          // tool_call

          // `agent.handoff` is a runtime-controlled pseudo-tool: it appears
          // in the LLM tool list (so the model can invoke it) but the runtime
          // intercepts the call here rather than running the tool body.
          // We swap the active agent for the rest of the tick, persist the
          // new `currentAgentId`, audit the handoff as a `tool.invoked`, and
          // push a tool-result back into the conversation so the new agent
          // sees the prior agent's work plus a record of the transition.
          if (decision.tool === "agent.handoff") {
            const raw = decision.input as {
              readonly targetAgent?: unknown;
              readonly reason?: unknown;
            } | null;
            const target =
              raw && typeof raw.targetAgent === "string"
                ? raw.targetAgent
                : null;
            const reason =
              raw && typeof raw.reason === "string" ? raw.reason : "";
            const allowed =
              target !== null &&
              agent.handoffs.some((h) => (h as string) === target);

            if (!allowed) {
              yield* tx.run(
                audit.record({
                  tenantId: current.tenantId,
                  caseId: current.id,
                  actor: { type: "agent", id: agent.id },
                  action: "tool.invoked",
                  details: {
                    tool: "agent.handoff",
                    callId: decision.callId,
                    ok: false,
                    error: "target_not_in_handoffs",
                    target,
                    turn,
                  },
                }),
              );
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
              continue;
            }

            const targetAgentId = makeAgentId(target as string);
            const targetAgent = yield* registry.resolve(targetAgentId);
            current = yield* tx.run(
              Effect.gen(function* () {
                const updated = yield* cases.update(current.id, {
                  currentAgentId: targetAgentId,
                });
                yield* audit.record({
                  tenantId: updated.tenantId,
                  caseId: updated.id,
                  actor: { type: "agent", id: agent.id },
                  action: "tool.invoked",
                  details: {
                    tool: "agent.handoff",
                    callId: decision.callId,
                    ok: true,
                    target: target as string,
                    reason,
                    turn,
                  },
                });
                return updated;
              }),
            );
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: "agent.handoff",
              content: { ok: true, targetAgent: target as string },
            });
            agent = targetAgent;
            continue;
          }

          const tool = yield* tools.tryGet(decision.tool);
          if (!tool) {
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: decision.tool,
              content: { error: "unknown_tool" },
            });
            continue;
          }

          const permission = yield* perms.check({
            tenantId: current.tenantId,
            agent,
            tool,
            payload: decision.input,
          });

          if (permission === "deny") {
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: tool.name,
              content: { error: "denied_by_policy" },
            });
            continue;
          }

          if (permission === "ask") {
            const approval = yield* approvals.create({
              tenantId: current.tenantId,
              caseId: current.id,
              agentId: agent.id,
              tool: tool.name,
              proposedInput: decision.input,
              reasoning: decision.reasoning ?? "",
              riskLevel: riskFor(tool),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
            current = yield* cases.transitionStatus(
              current.id,
              "waiting_for_approval",
              { reason: `tool ${tool.name} pending approval` },
            );
            return {
              type: "PausedWaitingForApproval",
              approvalId: approval.id,
            } as const;
          }

          // allow → execute (tool side effects + tool.invoked audit in one
          // tx — master-plan §4 audit-in-transaction invariant). If the tool
          // mutated case state (e.g. via case.update_status), the row write,
          // the case_state_transitions row, AND the audit entry all commit
          // together. If anything fails, all three roll back.
          const ctx: ToolContext = {
            tenantId: current.tenantId,
            caseId: current.id,
            agentId: agent.id,
            callId: decision.callId,
            attemptNumber: 1,
          };
          // Tool<unknown, unknown> declares R=unknown (master-plan §17). The
          // concrete dependencies a tool actually needs are satisfied by the
          // runtime's outer Layer, so we narrow R to never at the call site.
          const toolEffect = tool.execute(
            decision.input,
            ctx,
          ) as unknown as Effect.Effect<unknown, unknown, never>;
          const exec = yield* tx.run(
            Effect.gen(function* () {
              const result = yield* toolEffect.pipe(Effect.either);
              yield* audit.record({
                tenantId: current.tenantId,
                caseId: current.id,
                actor: { type: "agent", id: agent.id },
                action: "tool.invoked",
                details: {
                  tool: tool.name,
                  callId: decision.callId,
                  ok: result._tag === "Right",
                },
              });
              return result;
            }),
          );

          if (exec._tag === "Right") {
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: tool.name,
              content: exec.right,
            });
            // The tool may have mutated the case (e.g. transitioned status).
            current = yield* cases.getById(current.id);
          } else {
            const errTag =
              (exec.left as { readonly _tag?: string })._tag ?? "ToolFailure";
            messages.push({
              role: "tool",
              toolCallId: decision.callId,
              toolName: tool.name,
              content: { error: errTag },
            });
          }
        }

        return {
          type: "HumanTakeoverRequired",
          reason: "max_turns_exceeded",
        } as const;
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.succeed({
            type: "Failed",
            reason: `runtime error: ${String(cause)}`,
            retryable: false,
          } as const),
        ),
      );

    return AgentRuntime.of({
      handleEvent: tick,
    });
  }),
);
