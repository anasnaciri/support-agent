import type { Permission } from "@support-agent/agent-core";
import {
  isConnectorScopeGranted,
  type AgentDto,
  type AgentOverrideRow,
  type CatalogResponse,
  type ToolDto,
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

/**
 * Every catalog tool a merchant can configure (those carrying a
 * `tenantControl`), in catalog order. The agent-agnostic counterpart of
 * `tenantConfigurableActions` — the permissions matrix builds its rows from
 * this, so internal plumbing tools (handoff, lookups, ticket bookkeeping)
 * never reach that page either.
 */
export const merchantConfigurableTools = (
  catalog: CatalogResponse,
): ReadonlyArray<ToolDto> =>
  catalog.tools.filter((t) => t.tenantControl !== undefined);

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
 * handoff, ticket bookkeeping — are filtered out, so they never reach the UI.
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
  /**
   * Stable key: the catalog tool name, or a synthetic `platform:*` id for a
   * capability not backed by an agent tool (see `PLATFORM_CAPABILITIES`).
   */
  readonly tool: string;
  /** Merchant-facing label for what the connection lets the platform do. */
  readonly label: string;
  /**
   * Every connector scope this capability needs. The granted dot is green only
   * when ALL of them are granted (`isCapabilityGranted`).
   */
  readonly scopes: ReadonlyArray<string>;
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

// Mirrors INTERNAL_TOOL_NAMES in @support-agent/tools (which the Worker bundle
// can't import). The api's validateCustomAgentInput is the real gate — this
// only shapes the custom-agent picker, so a drift here is cosmetic, not a hole.
const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agent.handoff",
  "ticket.update_context",
  "ticket.update_status",
]);

/** Tools a merchant may assign to a custom agent (catalog minus internal). */
export const assignableTools = (
  catalog: CatalogResponse,
): ReadonlyArray<ToolDto> =>
  catalog.tools.filter((t) => !INTERNAL_TOOL_NAMES.has(t.name));

/** A merchant-facing label for a tool: its displayName, else a humanized name. */
export const toolDisplayLabel = (tool: ToolDto): string =>
  tool.displayName ?? humanizeToolName(tool.name);

/** A gated tool needs an approval choice; read-only tools are always automatic. */
export const isGatedTool = (tool: ToolDto): boolean => tool.risk !== "read";

/**
 * One friendly capability per catalog tool that declares at least one
 * `requiredConnectorScopes` scope for the named provider. Sorted by label so
 * the list is stable between renders. The raw scope is carried (not shown) so
 * the page can render a granted/missing dot against the connection's scopes.
 *
 * Tools that match the provider but require NO scope (e.g.
 * `shopify.get_store_info`, whose Shop query needs no Shopify scope) are
 * excluded: the grid surfaces the scope→tool mapping and the re-OAuth signal,
 * and a scopeless capability belongs to neither — it has no scope to render a
 * granted dot against, so it would be painted permanently "not granted".
 */
export const capabilitiesForProvider = (
  catalog: CatalogResponse,
  provider: string,
): ReadonlyArray<ConnectorCapability> =>
  catalog.tools
    .filter(
      (t) =>
        t.requiredConnectorScopes?.provider === provider &&
        (t.requiredConnectorScopes?.scopes.length ?? 0) > 0,
    )
    .map((t) => ({
      tool: t.name,
      label:
        CAPABILITY_LABELS[t.name] ?? t.displayName ?? humanizeToolName(t.name),
      scopes: t.requiredConnectorScopes?.scopes ?? [],
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

/**
 * Capabilities the platform exercises with connector scopes that NO agent tool
 * declares — so the tool-derived grid above can't surface them, yet the OAuth
 * flow requests their scopes and the features break silently when a stale
 * connection predates them. Surfaced as their own rows so the operator sees the
 * full picture and the "Reinstall to update permissions" signal fires when a
 * scope is missing.
 *
 * Shopify:
 *  - Refund-modal restock (an operator dashboard action, not an agent tool)
 *    needs `write_inventory` — which also covers the `read_inventory` the
 *    restock-context query uses. `read_locations` is already shown via the
 *    pickup-locations tool, so it isn't repeated here.
 *  - The post-connect knowledge-base import job reads `read_legal_policies`
 *    (shipping/refund policies) and `read_online_store_pages` (About/Contact/FAQ).
 */
const PLATFORM_CAPABILITIES: Readonly<
  Record<string, ReadonlyArray<ConnectorCapability>>
> = {
  shopify: [
    {
      tool: "platform:shopify.refund_restock",
      label: "Restock returned items on refunds",
      scopes: ["write_inventory"],
    },
    {
      tool: "platform:shopify.policy_import",
      label: "Import store policies & pages",
      scopes: ["read_legal_policies", "read_online_store_pages"],
    },
  ],
};

/**
 * Non-tool capabilities for a provider — features that consume connector scopes
 * but have no catalog tool, so `capabilitiesForProvider` never lists them. The
 * Manage page concatenates these onto the tool-derived rows.
 */
export const platformCapabilitiesForProvider = (
  provider: string,
): ReadonlyArray<ConnectorCapability> => PLATFORM_CAPABILITIES[provider] ?? [];

/**
 * Whether a capability is unlocked by the connection's granted scopes — true
 * only when EVERY scope it needs is granted. Defers per-scope coverage (e.g.
 * Shopify's `write_X` implies `read_X`) to the shared `isConnectorScopeGranted`
 * rule, so the dashboard dot never disagrees with the runtime precheck.
 */
export const isCapabilityGranted = (
  provider: string,
  capability: ConnectorCapability,
  grantedScopes: ReadonlyArray<string>,
): boolean =>
  capability.scopes.every((s) =>
    isConnectorScopeGranted(provider, s, grantedScopes),
  );
