import { Context, Effect, Layer } from "effect";
import type { AgentConfig, AgentId, TenantId } from "@support-agent/agent-core";

// ============================================================
// Tag
// ============================================================

/**
 * Tenant-aware agent resolution — the single seam the runtime uses instead of
 * calling `AgentRegistry.resolve` directly. It looks up built-in agents first
 * and falls back to the tenant's merchant-authored custom agents, projecting a
 * custom record into a full `AgentConfig` so the rest of the runtime treats
 * both kinds identically. Returns null on a real miss (unknown id, wrong
 * tenant, draft/disabled custom agent) — the runtime turns that into a
 * fail-safe `human_takeover` at the initial-load site.
 *
 * The Live impl lives in `@support-agent/agents` (it needs the prompt scaffold
 * + the AgentRegistry); the Tag lives here so `agent-runtime` can yield it
 * without importing `agents`.
 */
export class AgentResolver extends Context.Tag("AgentResolver")<
  AgentResolver,
  {
    readonly tryResolve: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<AgentConfig | null>;
  }
>() {}

// ============================================================
// Test Layer — in-memory
// ============================================================

/**
 * Resolves from explicit lists of built-in and per-tenant custom configs.
 * Built-ins win on id collision (mirrors the Live precedence). Custom configs
 * only resolve for their seeded tenant.
 */
export const AgentResolverTest = (
  builtins: ReadonlyArray<AgentConfig>,
  customs: ReadonlyArray<{
    readonly tenantId: TenantId;
    readonly config: AgentConfig;
  }> = [],
) =>
  Layer.succeed(
    AgentResolver,
    AgentResolver.of({
      tryResolve: (tenantId, agentId) =>
        Effect.sync(() => {
          const builtin = builtins.find(
            (a) => (a.id as string) === (agentId as string),
          );
          if (builtin) return builtin;
          const custom = customs.find(
            (c) =>
              c.tenantId === tenantId &&
              (c.config.id as string) === (agentId as string),
          );
          return custom ? custom.config : null;
        }),
    }),
  );
