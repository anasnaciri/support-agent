import { Context, Effect, Layer } from "effect";
import {
  type AgentId,
  type ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

/**
 * Per-tenant per-agent override row. The agent's hardcoded
 * `AgentConfig.model` is used unless this row exists and supplies a
 * different value. Today only the model is overridable, but this shape
 * is structured to grow (temperature, maxTurns, prompt suffix, …) without
 * a new Tag.
 */
export interface AgentOverride {
  readonly agentId: AgentId;
  readonly model: string | null;
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

    /** Upsert the model override for one (tenant, agent) pair. */
    readonly setModel: (
      tenantId: TenantId,
      agentId: AgentId,
      model: string,
    ) => Effect.Effect<void, ConnectorStoreDbError>;

    /** Drop the override row entirely (revert to AgentConfig default). */
    readonly clearModel: (
      tenantId: TenantId,
      agentId: AgentId,
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
  seed: ReadonlyArray<{ readonly tenantId: TenantId } & AgentOverride> = [],
) =>
  Layer.sync(TenantAgentOverridesService, () => {
    const store = new Map<string, { tenantId: TenantId; override: AgentOverride }>();
    for (const row of seed) {
      store.set(keyStr({ tenantId: row.tenantId, agentId: row.agentId }), {
        tenantId: row.tenantId,
        override: {
          agentId: row.agentId,
          model: row.model,
          updatedAt: row.updatedAt,
        },
      });
    }

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
          store.set(keyStr({ tenantId, agentId }), {
            tenantId,
            override: { agentId, model, updatedAt: new Date() },
          });
        }),

      clearModel: (tenantId, agentId) =>
        Effect.sync(() => {
          store.delete(keyStr({ tenantId, agentId }));
        }),
    });
  });
