import { Context, Data, Effect, Layer, Ref } from "effect";
import type { AgentId } from "./ids.js";
import type { AgentConfig } from "./agent.js";

// ============================================================
// Errors
// ============================================================

export class AgentAlreadyRegistered extends Data.TaggedError(
  "AgentAlreadyRegistered",
)<{
  readonly agentId: AgentId;
}> {}

export class UnknownAgent extends Data.TaggedError("UnknownAgent")<{
  readonly agentId: AgentId;
}> {}

export type AgentRegistryError = AgentAlreadyRegistered | UnknownAgent;

// ============================================================
// Tag
// ============================================================

export class AgentRegistry extends Context.Tag("AgentRegistry")<
  AgentRegistry,
  {
    readonly register: (
      config: AgentConfig,
    ) => Effect.Effect<void, AgentAlreadyRegistered>;
    readonly resolve: (
      id: AgentId,
    ) => Effect.Effect<AgentConfig, UnknownAgent>;
    readonly tryResolve: (id: AgentId) => Effect.Effect<AgentConfig | null>;
    readonly all: () => Effect.Effect<ReadonlyArray<AgentConfig>>;
  }
>() {}

// ============================================================
// Default Layer — in-memory, Ref-backed
// ============================================================

export const AgentRegistryDefault = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, AgentConfig>>(new Map());

    const register = (
      config: AgentConfig,
    ): Effect.Effect<void, AgentAlreadyRegistered> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        if (map.has(config.id)) {
          return yield* Effect.fail(
            new AgentAlreadyRegistered({ agentId: config.id }),
          );
        }
        const next = new Map(map);
        next.set(config.id, config);
        yield* Ref.set(ref, next);
      });

    const tryResolve = (id: AgentId) =>
      Ref.get(ref).pipe(Effect.map((map) => map.get(id) ?? null));

    const resolve = (id: AgentId) =>
      tryResolve(id).pipe(
        Effect.flatMap((c) =>
          c ? Effect.succeed(c) : Effect.fail(new UnknownAgent({ agentId: id })),
        ),
      );

    const all = () =>
      Ref.get(ref).pipe(Effect.map((map) => Array.from(map.values())));

    return AgentRegistry.of({ register, resolve, tryResolve, all });
  }),
);

/**
 * Builds a Layer that pre-registers the given agent configs. Useful for boot
 * (load a static manifest) and tests.
 */
export const AgentRegistryWith = (configs: ReadonlyArray<AgentConfig>) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      for (const config of configs) {
        yield* registry.register(config);
      }
    }),
  ).pipe(Layer.provideMerge(AgentRegistryDefault));
