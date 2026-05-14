import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentAlreadyRegistered,
  AgentRegistry,
  AgentRegistryDefault,
  AgentRegistryWith,
  UnknownAgent,
} from "../src/agent-registry.js";
import { AgentId } from "../src/ids.js";
import type { AgentConfig } from "../src/agent.js";

const make = (id: string): AgentConfig => ({
  id: AgentId(id),
  name: id,
  description: `${id} description`,
  mode: "primary",
  provider: "openrouter",
  model: "anthropic/claude-3.5-sonnet",
  promptTemplate: "test prompt",
  tools: [],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 4,
});

const a = make("support-triage");
const b = make("missing-package-agent");

const run = <A, E>(eff: Effect.Effect<A, E, AgentRegistry>) =>
  Effect.runPromise(Effect.provide(eff, AgentRegistryDefault));

const runExit = <A, E>(eff: Effect.Effect<A, E, AgentRegistry>) =>
  Effect.runPromiseExit(Effect.provide(eff, AgentRegistryDefault));

describe("AgentRegistry (default layer)", () => {
  it("register + resolve round-trip", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry;
        yield* reg.register(a);
        return yield* reg.resolve(a.id);
      }),
    );
    expect(out.id).toBe("support-triage");
  });

  it("resolve unknown id fails with UnknownAgent", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry;
        return yield* reg.resolve(AgentId("nope"));
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(UnknownAgent);
    }
  });

  it("tryResolve returns null for unknown id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry;
        return yield* reg.tryResolve(AgentId("nope"));
      }),
    );
    expect(out).toBeNull();
  });

  it("duplicate register fails with AgentAlreadyRegistered", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry;
        yield* reg.register(a);
        return yield* reg.register(a);
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(AgentAlreadyRegistered);
    }
  });

  it("all returns every registered config", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry;
        yield* reg.register(a);
        yield* reg.register(b);
        return yield* reg.all();
      }),
    );
    expect(out.map((c) => c.id).sort()).toEqual([
      "missing-package-agent",
      "support-triage",
    ]);
  });
});

describe("AgentRegistryWith — pre-registered layer", () => {
  it("exposes agents provided at construction time", async () => {
    const layer = AgentRegistryWith([a, b]);
    const all = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.all();
        }),
        layer,
      ),
    );
    expect(all).toHaveLength(2);
  });

  it("has the expected Layer shape", () => {
    const _l: Layer.Layer<AgentRegistry> = AgentRegistryWith([a]);
    expect(typeof _l).toBe("object");
  });
});
