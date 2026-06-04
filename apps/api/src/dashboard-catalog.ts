import type { AgentConfig, AnyTool } from "@support-agent/agent-core";
import type {
  AgentDto,
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";

// Project the in-code agent/tool registry to plain JSON DTOs for the dashboard
// (Path B). The dashboard renders its settings pages from this snapshot — it
// can't keep `@support-agent/agents`/`tools` in its Worker bundle because they
// transitively import `@support-agent/services` (node built-ins). The DTO
// shapes are the single source of truth in `@support-agent/dashboard-contracts`.
//
// `exactOptionalPropertyTypes` is on, so optional fields are spread
// conditionally rather than set to `undefined`.

export const toAgentDto = (a: AgentConfig): AgentDto => ({
  id: a.id,
  name: a.name,
  description: a.description,
  mode: a.mode,
  provider: a.provider,
  model: a.model,
  ...(a.fallback !== undefined ? { fallback: a.fallback } : {}),
  promptTemplate: a.promptTemplate,
  tools: a.tools,
  permissionOverrides: a.permissionOverrides,
  handoffs: a.handoffs,
  maxTurnsPerTick: a.maxTurnsPerTick,
  ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
});

export const toToolDto = (t: AnyTool): ToolDto => ({
  name: t.name,
  description: t.description,
  risk: t.risk,
  defaultPermission: t.defaultPermission,
  sideEffectClass: t.sideEffectClass,
  ...(t.requiredConnectorScopes !== undefined
    ? { requiredConnectorScopes: t.requiredConnectorScopes }
    : {}),
});

export const buildCatalogResponse = (
  agents: ReadonlyArray<AgentConfig>,
  tools: ReadonlyArray<AnyTool>,
): CatalogResponse => ({
  agents: agents.map(toAgentDto),
  tools: tools.map(toToolDto),
});
