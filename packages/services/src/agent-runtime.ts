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

        // 1. Load or create the case.
        const caseRow =
          lookup.kind === "load"
            ? yield* cases.getById(lookup.caseId as never)
            : yield* cases.create({
                tenantId: lookup.tenantId as never,
                channel: lookup.channel,
                currentAgentId: makeAgentId("support-triage"),
                subject: lookup.subject,
              });

        // 2. Record event arrival.
        yield* audit.record({
          tenantId: caseRow.tenantId,
          caseId: caseRow.id,
          actor: { type: "system", id: "runtime" },
          action: "event.received",
          details: { eventType: event.type },
        });

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
              current = yield* cases.transitionStatus(current.id, "resolved", {
                reason: "runtime: final_message",
              });
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

          // allow → execute
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
          const exec = yield* toolEffect.pipe(Effect.either);

          yield* audit.record({
            tenantId: current.tenantId,
            caseId: current.id,
            actor: { type: "agent", id: agent.id },
            action: "tool.invoked",
            details: {
              tool: tool.name,
              callId: decision.callId,
              ok: exec._tag === "Right",
            },
          });

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
