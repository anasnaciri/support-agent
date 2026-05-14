import { Context, Data, Effect, JSONSchema, Layer, Ref } from "effect";
import type { Tool } from "./tool.js";
import type { ToolSchema } from "./llm.js";

// ============================================================
// Errors
// ============================================================

export class ToolAlreadyRegistered extends Data.TaggedError(
  "ToolAlreadyRegistered",
)<{
  readonly name: string;
}> {}

export class UnknownTool extends Data.TaggedError("UnknownTool")<{
  readonly name: string;
}> {}

export type ToolRegistryError = ToolAlreadyRegistered | UnknownTool;

// ============================================================
// Tag
// ============================================================

// We store tools with `unknown` I/O because the registry is a heterogeneous
// collection. The original `Tool<I, O>` types are preserved at each tool's
// definition site via `defineTool`.
export type AnyTool = Tool<unknown, unknown>;

export class ToolRegistry extends Context.Tag("ToolRegistry")<
  ToolRegistry,
  {
    readonly register: (tool: AnyTool) => Effect.Effect<void, ToolAlreadyRegistered>;
    readonly get: (name: string) => Effect.Effect<AnyTool, UnknownTool>;
    readonly tryGet: (name: string) => Effect.Effect<AnyTool | null>;
    readonly schemasFor: (
      names: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ToolSchema>, UnknownTool>;
    readonly all: () => Effect.Effect<ReadonlyArray<AnyTool>>;
  }
>() {}

// ============================================================
// Default layer — in-memory, Ref-backed
// ============================================================

const toToolSchema = (tool: AnyTool): ToolSchema => ({
  name: tool.name,
  description: tool.description,
  inputSchema: JSONSchema.make(tool.inputSchema) as unknown as Readonly<
    Record<string, unknown>
  >,
});

export const ToolRegistryDefault = Layer.effect(
  ToolRegistry,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyMap<string, AnyTool>>(new Map());

    const register = (
      tool: AnyTool,
    ): Effect.Effect<void, ToolAlreadyRegistered> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        if (map.has(tool.name)) {
          return yield* Effect.fail(
            new ToolAlreadyRegistered({ name: tool.name }),
          );
        }
        const next = new Map(map);
        next.set(tool.name, tool);
        yield* Ref.set(ref, next);
      });

    const tryGet = (name: string) =>
      Ref.get(ref).pipe(Effect.map((map) => map.get(name) ?? null));

    const get = (name: string) =>
      tryGet(name).pipe(
        Effect.flatMap((t) =>
          t ? Effect.succeed(t) : Effect.fail(new UnknownTool({ name })),
        ),
      );

    const schemasFor = (names: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(ref);
        const out: ToolSchema[] = [];
        for (const name of names) {
          const t = map.get(name);
          if (!t) return yield* Effect.fail(new UnknownTool({ name }));
          out.push(toToolSchema(t));
        }
        return out;
      });

    const all = () =>
      Ref.get(ref).pipe(Effect.map((map) => Array.from(map.values())));

    return ToolRegistry.of({ register, get, tryGet, schemasFor, all });
  }),
);

/**
 * Builds a layer that pre-registers the given tools. Useful for tests and
 * for wiring the registry from a static tool manifest.
 */
export const ToolRegistryWith = (tools: ReadonlyArray<AnyTool>) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry;
      for (const tool of tools) {
        yield* registry.register(tool);
      }
    }),
  ).pipe(Layer.provideMerge(ToolRegistryDefault));
