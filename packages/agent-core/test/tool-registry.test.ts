import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineTool } from "../src/define-tool.js";
import {
  ToolAlreadyRegistered,
  ToolRegistry,
  ToolRegistryDefault,
  ToolRegistryWith,
  UnknownTool,
} from "../src/tool-registry.js";
import type { Tool } from "../src/tool.js";

// Two trivial tools for testing
const echoTool = defineTool({
  name: "test.echo",
  description: "Echoes back the input message.",
  inputSchema: Schema.Struct({ msg: Schema.String }),
  outputSchema: Schema.Struct({ msg: Schema.String }),
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input) => Effect.succeed({ msg: input.msg }),
});

const addTool = defineTool({
  name: "test.add",
  description: "Adds two numbers and returns the sum.",
  inputSchema: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  outputSchema: Schema.Struct({ sum: Schema.Number }),
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  execute: (input) => Effect.succeed({ sum: input.a + input.b }),
});

const runDefault = <A, E>(eff: Effect.Effect<A, E, ToolRegistry>) =>
  Effect.runPromise(Effect.provide(eff, ToolRegistryDefault));

const runDefaultExit = <A, E>(eff: Effect.Effect<A, E, ToolRegistry>) =>
  Effect.runPromiseExit(Effect.provide(eff, ToolRegistryDefault));

describe("defineTool", () => {
  it("preserves I/O type parameters", () => {
    // echoTool.execute should accept { msg: string }; this checks at compile time
    const t: Tool<{ msg: string }, { msg: string }> = echoTool;
    expect(t.name).toBe("test.echo");
    expect(t.risk).toBe("read");
  });
});

describe("ToolRegistry (default layer)", () => {
  it("register + get round-trip", async () => {
    const out = await runDefault(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        yield* reg.register(echoTool as never);
        return yield* reg.get("test.echo");
      }),
    );
    expect(out.name).toBe("test.echo");
  });

  it("get of unknown tool fails with UnknownTool", async () => {
    const exit = await runDefaultExit(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        return yield* reg.get("test.missing");
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UnknownTool);
    }
  });

  it("tryGet returns null instead of failing", async () => {
    const out = await runDefault(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        return yield* reg.tryGet("test.missing");
      }),
    );
    expect(out).toBeNull();
  });

  it("register fails with ToolAlreadyRegistered on duplicate name", async () => {
    const exit = await runDefaultExit(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        yield* reg.register(echoTool as never);
        return yield* reg.register(echoTool as never);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ToolAlreadyRegistered);
    }
  });

  it("all returns every registered tool", async () => {
    const out = await runDefault(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        yield* reg.register(echoTool as never);
        yield* reg.register(addTool as never);
        return yield* reg.all();
      }),
    );
    expect(out.map((t) => t.name).sort()).toEqual(["test.add", "test.echo"]);
  });

  it("schemasFor produces JSON-Schema-shaped descriptors for the LLM", async () => {
    const schemas = await runDefault(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        yield* reg.register(echoTool as never);
        yield* reg.register(addTool as never);
        return yield* reg.schemasFor(["test.add", "test.echo"]);
      }),
    );
    expect(schemas).toHaveLength(2);
    expect(schemas[0]?.name).toBe("test.add");
    expect(schemas[0]?.description).toBe(
      "Adds two numbers and returns the sum.",
    );
    // Effect's JSONSchema.make produces a draft-7 / draft-2020 shape; we
    // only assert the most stable fields here.
    expect(schemas[0]?.inputSchema["type"]).toBe("object");
    expect(schemas[0]?.inputSchema["properties"]).toBeDefined();
  });

  it("schemasFor fails if any requested tool is unknown", async () => {
    const exit = await runDefaultExit(
      Effect.gen(function* () {
        const reg = yield* ToolRegistry;
        yield* reg.register(echoTool as never);
        return yield* reg.schemasFor(["test.echo", "test.missing"]);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UnknownTool);
    }
  });
});

describe("ToolRegistryWith — pre-registered layer", () => {
  it("exposes tools provided at construction time", async () => {
    const layer = ToolRegistryWith([echoTool as never, addTool as never]);
    const all = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* ToolRegistry;
          return yield* reg.all();
        }),
        layer,
      ),
    );
    expect(all.map((t) => t.name).sort()).toEqual(["test.add", "test.echo"]);
  });

  // sanity: layer composability (consumer can re-provide a different layer)
  it("layered consumption stays type-safe", () => {
    const _l: Layer.Layer<ToolRegistry> = ToolRegistryWith([
      echoTool as never,
    ]);
    expect(typeof _l).toBe("object");
  });
});
