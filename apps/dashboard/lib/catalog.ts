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

/**
 * One row of the per-provider capability grid rendered on
 * `/settings/integrations`. Derived from the tools' own
 * `requiredConnectorScopes` declarations — adding a new tool that
 * declares a new scope automatically surfaces it as a new capability,
 * with no edits to the dashboard.
 */
export interface ConnectorCapability {
  /** Raw scope string (matches what Shopify / Google echo back on OAuth). */
  readonly scope: string;
  /** Comma-separated tool names that need this scope. */
  readonly tools: string;
}

/**
 * Distinct `requiredConnectorScopes` entries declared across `ALL_TOOLS`
 * for the named provider, grouped by scope and tagged with the tools
 * that need each. Stable order: alphabetical by scope so the grid
 * doesn't reshuffle between renders.
 */
export const capabilitiesForProvider = (
  provider: string,
): ReadonlyArray<ConnectorCapability> => {
  const byScope = new Map<string, string[]>();
  for (const t of tools) {
    const req = t.requiredConnectorScopes;
    if (!req || req.provider !== provider) continue;
    for (const s of req.scopes) {
      const bucket = byScope.get(s) ?? [];
      bucket.push(t.name);
      byScope.set(s, bucket);
    }
  }
  return [...byScope.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([scope, toolNames]) => ({
      scope,
      tools: toolNames.join(", "),
    }));
};
