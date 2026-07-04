import { Effect, Schema } from "effect";
import { defineTool } from "@support-agent/agent-core";

/**
 * `agent.handoff` is intercepted by `AgentRuntime` BEFORE the tool body runs:
 * the runtime validates `targetAgent` against the calling agent's `handoffs`
 * list, swaps the active agent for the rest of the tick, audits the handoff
 * as a `tool.invoked`, and pushes a tool-result back into the conversation.
 *
 * The body below is therefore only a safety fallback (and a way to keep the
 * tool a normal `defineTool` so its JSON Schema flows to the LLM through the
 * usual `ToolRegistry.schemasFor` path). It should never actually execute
 * inside the production runtime.
 */
const Input = Schema.Struct({
  targetAgent: Schema.String,
  reason: Schema.optional(Schema.String),
});

const Output = Schema.Struct({
  ok: Schema.Boolean,
  targetAgent: Schema.String,
});

export const agentHandoff = defineTool({
  name: "agent.handoff",
  description:
    "Hand off the ticket to a specialized agent. `targetAgent` must be one of the agents listed as a valid handoff target for the current agent. Use this when the user's request is fully classified and a downstream specialist should answer it.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input) =>
    Effect.succeed({ ok: true, targetAgent: input.targetAgent }),
});
