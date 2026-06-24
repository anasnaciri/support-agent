import type { AgentConfig, AnyTool } from "@support-agent/agent-core";
import type {
  AgentDto,
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import { customRecordToAgentConfig } from "@support-agent/agents";
import type { CustomAgentRecord } from "@support-agent/services";

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
  isCustom: false,
});

// A merchant-authored agent projected for the catalog. Goes through the same
// `customRecordToAgentConfig` projection the runtime uses (scaffold-composed
// prompt, pinned mode/provider, implicit agent.handoff) and then carries the
// custom-only fields (isCustom, whenToUse, callableFrom).
export const customRecordToAgentDto = (r: CustomAgentRecord): AgentDto => ({
  ...toAgentDto(customRecordToAgentConfig(r)),
  isCustom: true,
  whenToUse: r.whenToUse,
  callableFrom: r.callableFrom,
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
  ...(t.displayName !== undefined ? { displayName: t.displayName } : {}),
  ...(t.displayDescription !== undefined
    ? { displayDescription: t.displayDescription }
    : {}),
  ...(t.tenantControl !== undefined
    ? { tenantControl: t.tenantControl }
    : {}),
});

export const buildCatalogResponse = (
  agents: ReadonlyArray<AgentConfig>,
  tools: ReadonlyArray<AnyTool>,
  customs: ReadonlyArray<CustomAgentRecord> = [],
): CatalogResponse => ({
  agents: [...agents.map(toAgentDto), ...customs.map(customRecordToAgentDto)],
  tools: tools.map(toToolDto),
});
