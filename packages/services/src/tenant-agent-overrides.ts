import { Context, Effect, Layer } from "effect";
import {
  type AgentId,
  type ConnectorStoreDbError,
  type Permission,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

/**
 * Per-tenant per-agent override row. Each field overlays the in-code
 * `AgentConfig`:
 *   - `model` overrides `AgentConfig.model` (null → use the config default).
 *   - `systemPrompt` is tenant-authored text **appended** to
 *     `AgentConfig.promptTemplate` as extra instructions (brand voice,
 *     policy, tone) — not a replacement, so the agent keeps its tool /
 *     handoff / approval scaffolding (null → no extra instructions).
 *
 *   - `toolPermissions` is a per-tool "ask first" vs "auto" map keyed by tool
 *     name (e.g. `{ "conversation.reply": "allow" }`); the runtime overlays it
 *     onto `AgentConfig.permissionOverrides` (null / empty → no overrides).
 *
 * All three fields share ONE row per (tenant, agent), so clears are field-aware:
 * setting one field preserves the others, and the row is removed only when
 * all are empty. The shape is still structured to grow (temperature,
 * maxTurns, …) without a new Tag.
 */
export interface AgentOverride {
  readonly agentId: AgentId;
  readonly model: string | null;
  readonly systemPrompt: string | null;
  readonly toolPermissions: Readonly<Record<string, Permission>> | null;
  readonly updatedAt: Date;
}

// ============================================================
// Tag
// ============================================================

/**
 * Resolves per-(tenant, agent) overrides applied on top of the in-code
 * `AgentConfig`. Reads happen on every runtime tick (one extra SELECT
 * before each LLM call), so the Live impl is intentionally small and
 * the Test impl is in-memory.
 */
export class TenantAgentOverridesService extends Context.Tag(
  "TenantAgentOverridesService",
)<
  TenantAgentOverridesService,
  {
    /**
     * Returns every override row for the tenant keyed by agent id. The
     * runtime calls this once per tick and reads the map; absent
     * agentIds fall through to AgentConfig defaults.
     */
    readonly getForTenant: (
      tenantId: TenantId,
    ) => Effect.Effect<
      ReadonlyMap<AgentId, AgentOverride>,
      ConnectorStoreDbError
    >;

    /**
     * Upsert the model override for one (tenant, agent) pair. Preserves any
     * existing `systemPrompt` on the same row.
     */
    readonly setModel: (
      tenantId: TenantId,
      agentId: AgentId,
      model: string,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /**
     * Clear the model override (revert to AgentConfig default). Preserves any
     * `systemPrompt` on the same row; the row is removed only when both
     * fields become null.
     */
    readonly clearModel: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /**
     * Upsert the tenant-authored system prompt for one (tenant, agent) pair.
     * Preserves any existing `model` override on the same row.
     */
    readonly setSystemPrompt: (
      tenantId: TenantId,
      agentId: AgentId,
      systemPrompt: string,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /**
     * Clear the system prompt (revert to the bare AgentConfig prompt).
     * Preserves any `model` override on the same row; the row is removed only
     * when both fields become null.
     */
    readonly clearSystemPrompt: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /**
     * Set the "ask first" vs "auto" choice for one tool on one (tenant, agent)
     * pair. Merges into the existing `toolPermissions` map (other tools and the
     * model/systemPrompt fields are preserved).
     */
    readonly setToolPermission: (
      tenantId: TenantId,
      agentId: AgentId,
      toolName: string,
      permission: Permission,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /**
     * Drop the per-agent override for one tool (revert to the agent default).
     * Removes just that key from the `toolPermissions` map; the row is removed
     * only when model, systemPrompt, and the whole map are all empty.
     */
    readonly clearToolPermission: (
      tenantId: TenantId,
      agentId: AgentId,
      toolName: string,
    ) => Effect.Effect<void, ConnectorStoreDbError>;
  }
>() {}

// ============================================================
// Test Layer — in-memory, mutable
// ============================================================

interface TestKey {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
}

const keyStr = (k: TestKey): string => `${k.tenantId}\x00${k.agentId}`;

export const TenantAgentOverridesServiceTest = (
  seed: ReadonlyArray<{
    readonly tenantId: TenantId;
    readonly agentId: AgentId;
    readonly model?: string | null;
    readonly systemPrompt?: string | null;
    readonly toolPermissions?: Readonly<Record<string, Permission>> | null;
    readonly updatedAt: Date;
  }> = [],
) =>
  Layer.sync(TenantAgentOverridesService, () => {
    const store = new Map<string, { tenantId: TenantId; override: AgentOverride }>();
    for (const row of seed) {
      store.set(keyStr({ tenantId: row.tenantId, agentId: row.agentId }), {
        tenantId: row.tenantId,
        override: {
          agentId: row.agentId,
          model: row.model ?? null,
          systemPrompt: row.systemPrompt ?? null,
          toolPermissions: row.toolPermissions ?? null,
          updatedAt: row.updatedAt,
        },
      });
    }

    // Collapse an empty/absent tool-permission map to null so the field-aware
    // delete below treats "no tools left" identically to "never had any".
    const normalizeTp = (
      tp: Readonly<Record<string, Permission>> | null,
    ): Readonly<Record<string, Permission>> | null =>
      tp && Object.keys(tp).length > 0 ? tp : null;

    // Read the current override for a key, defaulting to an all-null shape so
    // a partial set/clear can merge against it.
    const current = (tenantId: TenantId, agentId: AgentId): AgentOverride =>
      store.get(keyStr({ tenantId, agentId }))?.override ?? {
        agentId,
        model: null,
        systemPrompt: null,
        toolPermissions: null,
        updatedAt: new Date(),
      };

    // Persist a merged override, removing the row entirely when ALL overridable
    // fields are empty (so an empty row never lingers).
    const put = (tenantId: TenantId, override: AgentOverride): void => {
      const key = keyStr({ tenantId, agentId: override.agentId });
      const tp = normalizeTp(override.toolPermissions);
      if (
        override.model === null &&
        override.systemPrompt === null &&
        tp === null
      ) {
        store.delete(key);
        return;
      }
      store.set(key, { tenantId, override: { ...override, toolPermissions: tp } });
    };

    return TenantAgentOverridesService.of({
      getForTenant: (tenantId) =>
        Effect.sync(() => {
          const result = new Map<AgentId, AgentOverride>();
          for (const entry of store.values()) {
            if (entry.tenantId === tenantId) {
              result.set(entry.override.agentId, entry.override);
            }
          }
          return result;
        }),

      setModel: (tenantId, agentId, model) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          put(tenantId, { ...prev, agentId, model, updatedAt: new Date() });
        }),

      clearModel: (tenantId, agentId) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          put(tenantId, { ...prev, agentId, model: null, updatedAt: new Date() });
        }),

      setSystemPrompt: (tenantId, agentId, systemPrompt) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          put(tenantId, {
            ...prev,
            agentId,
            systemPrompt,
            updatedAt: new Date(),
          });
        }),

      clearSystemPrompt: (tenantId, agentId) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          put(tenantId, {
            ...prev,
            agentId,
            systemPrompt: null,
            updatedAt: new Date(),
          });
        }),

      setToolPermission: (tenantId, agentId, toolName, permission) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          put(tenantId, {
            ...prev,
            agentId,
            toolPermissions: {
              ...(prev.toolPermissions ?? {}),
              [toolName]: permission,
            },
            updatedAt: new Date(),
          });
        }),

      clearToolPermission: (tenantId, agentId, toolName) =>
        Effect.sync(() => {
          const prev = current(tenantId, agentId);
          const { [toolName]: _removed, ...rest } = prev.toolPermissions ?? {};
          put(tenantId, {
            ...prev,
            agentId,
            toolPermissions: rest,
            updatedAt: new Date(),
          });
        }),
    });
  });
