import { Effect, Layer } from "effect";
import { AgentRegistry, type AgentConfig } from "@support-agent/agent-core";
import {
  AgentResolver,
  CustomAgentService,
  type CustomAgentRecord,
} from "@support-agent/services";
import { buildCustomAgentPromptTemplate } from "./custom-agent-scaffold.js";

/**
 * Project a stored custom-agent record into a full `AgentConfig` the runtime
 * can run. The merchant's raw `instructions` are wrapped in the shared prompt
 * scaffold here (resolve time), so a scaffold change reaches every existing
 * agent with no data migration. v1 custom agents are always `subagent` on the
 * tenant BYOK `openrouter` path, so both are pinned.
 *
 * `agent.handoff` is implicit: it is added to the tool set exactly when the
 * agent has outbound handoff targets (mirrors the built-ins, where only agents
 * that can hand off carry the tool), and is never stored on the record.
 */
export const customRecordToAgentConfig = (r: CustomAgentRecord): AgentConfig => {
  const base = r.tools.filter((t) => t !== "agent.handoff");
  const tools = r.handoffs.length > 0 ? [...base, "agent.handoff"] : base;
  return {
    id: r.agentId,
    name: r.name,
    description: r.description,
    mode: "subagent",
    provider: "openrouter",
    model: r.model,
    promptTemplate: buildCustomAgentPromptTemplate(r.instructions, {
      name: r.name,
    }),
    tools,
    permissionOverrides: r.permissionOverrides,
    handoffs: r.handoffs,
    maxTurnsPerTick: r.maxTurnsPerTick,
  };
};

/**
 * Live `AgentResolver`: built-in registry first, then the tenant's active
 * custom agents. A custom-store DB error degrades to "not found" (fail-safe:
 * the runtime treats a miss as `human_takeover`, never an infinite retry).
 */
export const AgentResolverLive = Layer.effect(
  AgentResolver,
  Effect.gen(function* () {
    const registry = yield* AgentRegistry;
    const customAgents = yield* CustomAgentService;
    return AgentResolver.of({
      tryResolve: (tenantId, agentId) =>
        Effect.gen(function* () {
          const builtin = yield* registry.tryResolve(agentId);
          if (builtin) return builtin;
          const custom = yield* customAgents
            .tryResolve(tenantId, agentId)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          return custom ? customRecordToAgentConfig(custom) : null;
        }),

      customSpecialists: (tenantId) =>
        customAgents.listForTenant(tenantId).pipe(
          Effect.catchAll(() => Effect.succeed([])),
          Effect.map((records) =>
            records.map((r) => ({
              id: r.agentId,
              name: r.name,
              description: r.description,
              whenToUse: r.whenToUse,
              callableFrom: r.callableFrom,
            })),
          ),
        ),
    });
  }),
);
