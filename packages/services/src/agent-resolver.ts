import { Context, Effect, Layer } from "effect";
import type { AgentConfig, AgentId, TenantId } from "@support-agent/agent-core";

// One active custom agent as a potential inbound-handoff target (Phase C). The
// runtime uses `callableFrom` to extend a calling agent's effective handoffs +
// to build the prompt roster.
export interface CustomSpecialistEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
  readonly callableFrom: ReadonlyArray<AgentId>;
}

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

    // Every active custom agent for the tenant, as inbound-handoff candidates
    // (Phase C). Loaded once per tick; never fails (DB error → empty).
    readonly customSpecialists: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<CustomSpecialistEntry>>;
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
    // Phase C inbound opt-in: agent ids this custom agent is callable from.
    readonly callableFrom?: ReadonlyArray<string>;
    readonly whenToUse?: string | null;
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

      customSpecialists: (tenantId) =>
        Effect.sync(() =>
          customs
            .filter((c) => c.tenantId === tenantId)
            .map((c) => ({
              id: c.config.id,
              name: c.config.name,
              description: c.config.description,
              whenToUse: c.whenToUse ?? null,
              callableFrom: (c.callableFrom ?? []).map(
                (x) => x as unknown as AgentId,
              ),
            })),
        ),
    }),
  );
