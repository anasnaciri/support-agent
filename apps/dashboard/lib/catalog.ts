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

/** One capability shown on a connector's Manage page. */
export interface ConnectorCapability {
  /** Tool name — stable key. */
  readonly tool: string;
  /** Merchant-facing label for what the connection lets the agent do. */
  readonly label: string;
  /** The connector scope this capability needs (for the granted dot). */
  readonly scope: string;
}

/**
 * Connector-capability labels, intentionally separate from a tool's agent-facing
 * `displayName`: the agent page calls `supplier.add_sheet_row` "Escalate to
 * supplier", but on the *connection* the plainer "Add row" describes what the
 * grant actually does. Only tools that need a friendlier-than-default name go
 * here; everything else falls back to `displayName`, then a humanized name.
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "supplier.read_sheet_columns": "Read sheet",
  "supplier.add_sheet_row": "Add row",
};

/** "shopify.get_order" -> "Get order". Drops the namespace, de-snakes, caps. */
const humanizeToolName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const base = (dot === -1 ? name : name.slice(dot + 1)).replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * One friendly capability per catalog tool that declares
 * `requiredConnectorScopes` for the named provider. Sorted by label so the list
 * is stable between renders. The raw scope is carried (not shown) so the page
 * can render a granted/missing dot against the connection's scopes.
 */
export const capabilitiesForProvider = (
  catalog: CatalogResponse,
  provider: string,
): ReadonlyArray<ConnectorCapability> =>
  catalog.tools
    .filter((t) => t.requiredConnectorScopes?.provider === provider)
    .map((t) => ({
      tool: t.name,
      label:
        CAPABILITY_LABELS[t.name] ?? t.displayName ?? humanizeToolName(t.name),
      scope: t.requiredConnectorScopes?.scopes[0] ?? "",
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
