import type { Permission } from "@support-agent/agent-core";
import type {
  AgentDto,
  AgentOverrideRow,
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";

// Pure views over the agent/tool inventory the api returns from
// GET /dashboard/catalog. (Pre-cutover this read ALL_AGENTS/ALL_TOOLS directly,
// but those packages transitively pull node built-ins and can't run on
// Workers — the api projects them to plain DTOs now.)

export const findAgent = (
  catalog: CatalogResponse,
  id: string,
): AgentDto | null => catalog.agents.find((a) => a.id === id) ?? null;

export const findTool = (
  catalog: CatalogResponse,
  name: string,
): ToolDto | null => catalog.tools.find((t) => t.name === name) ?? null;

export const effectivePermission = (
  agent: AgentDto,
  catalog: CatalogResponse,
  toolName: string,
): Permission | null => {
  const tool = findTool(catalog, toolName);
  if (!tool) return null;
  return agent.permissionOverrides[toolName] ?? tool.defaultPermission;
};

/** One tenant-configurable action shown on the agent page's "Actions" card. */
export interface ConfigurableAction {
  readonly tool: ToolDto;
  /**
   * The agent's default for this tool (an in-code pin if any, else the tool's
   * defaultPermission) — i.e. the value a tenant override reverts to.
   */
  readonly agentDefault: Permission;
}

/**
 * The agent's tools that a tenant may configure (those carrying a
 * `tenantControl`), in binding order. Internal plumbing tools — lookups,
 * handoff, case bookkeeping — are filtered out, so they never reach the UI.
 */
export const tenantConfigurableActions = (
  agent: AgentDto,
  catalog: CatalogResponse,
): ReadonlyArray<ConfigurableAction> =>
  agent.tools
    .map((name) => findTool(catalog, name))
    .filter(
      (t): t is ToolDto => t !== null && t.tenantControl !== undefined,
    )
    .map((tool) => ({
      tool,
      agentDefault:
        agent.permissionOverrides[tool.name] ?? tool.defaultPermission,
    }));

/**
 * The effective "ask first" vs "auto" state shown on the toggle: the tenant's
 * per-agent override if present, otherwise the agent default. Mirrors the
 * runtime's `applyOverride` + `PermissionService` resolution so the UI never
 * disagrees with what the agent will actually do.
 */
export const currentToolPermission = (
  agent: AgentDto,
  catalog: CatalogResponse,
  overrideRow: AgentOverrideRow | null,
  toolName: string,
): Permission | null => {
  const agentDefault = effectivePermission(agent, catalog, toolName);
  if (agentDefault === null) return null;
  return overrideRow?.toolPermissions?.[toolName] ?? agentDefault;
};

/** One row of the per-provider capability grid on `/settings/integrations`. */
export interface ConnectorCapability {
  readonly scope: string;
  readonly tools: string;
}

/**
 * Distinct `requiredConnectorScopes` entries across the catalog tools for the
 * named provider, grouped by scope and tagged with the tools that need each.
 * Alphabetical by scope so the grid is stable between renders.
 */
export const capabilitiesForProvider = (
  catalog: CatalogResponse,
  provider: string,
): ReadonlyArray<ConnectorCapability> => {
  const byScope = new Map<string, string[]>();
  for (const t of catalog.tools) {
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
    .map(([scope, toolNames]) => ({ scope, tools: toolNames.join(", ") }));
};
