import "server-only";
import type { AgentConfig, Tool, Permission } from "@support-agent/agent-core";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";

// Read-only inventory of every AgentConfig + Tool registered in the
// platform. Settings pages render from this in-memory snapshot. The
// `ALL_AGENTS` / `ALL_TOOLS` constants are the single source of truth
// — the worker bootstrap imports the same lists. New agent or tool?
// Add it to the registry export in @support-agent/agents or
// @support-agent/tools and both surfaces pick it up automatically.
//
// Edit flows (change a prompt, flip a permission) are intentionally
// deferred: today the configs live in code. Per-tenant variation is
// handled by narrow targeted tables (`tenant_agent_overrides` for
// model, `tenants.settings.refundPolicy` for refund thresholds) — we
// don't materialize a full per-tenant agent row because almost every
// tenant runs the same shared agent set.

export const agents: ReadonlyArray<AgentConfig> = ALL_AGENTS;

export const tools: ReadonlyArray<Tool<unknown, unknown>> =
  ALL_TOOLS as ReadonlyArray<Tool<unknown, unknown>>;

export const findAgent = (id: string): AgentConfig | null =>
  agents.find((a) => a.id === id) ?? null;

export const findTool = (name: string): Tool<unknown, unknown> | null =>
  tools.find((t) => t.name === name) ?? null;

export const effectivePermission = (
  agent: AgentConfig,
  toolName: string,
): Permission | null => {
  const tool = findTool(toolName);
  if (!tool) return null;
  return agent.permissionOverrides[toolName] ?? tool.defaultPermission;
};
