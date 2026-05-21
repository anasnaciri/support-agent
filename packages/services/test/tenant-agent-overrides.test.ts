import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId, TenantId } from "@support-agent/agent-core";
import {
  TenantAgentOverridesService,
  TenantAgentOverridesServiceTest,
} from "../src/tenant-agent-overrides.js";

const tenantA = TenantId("00000000-0000-0000-0000-0000000000aa");
const tenantB = TenantId("00000000-0000-0000-0000-0000000000bb");
const agentX = AgentId("support-triage");
const agentY = AgentId("order-status-agent");

describe("TenantAgentOverridesServiceTest", () => {
  it("returns an empty map for a tenant with no rows", async () => {
    const layer = TenantAgentOverridesServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(TenantAgentOverridesService, (s) =>
          s.getForTenant(tenantA),
        ),
        layer,
      ),
    );
    expect(out.size).toBe(0);
  });

  it("upserts a model override and reads it back keyed by agentId", async () => {
    const layer = TenantAgentOverridesServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantA, agentX, "anthropic/claude-opus-4-7");
          const m = yield* s.getForTenant(tenantA);
          return m;
        }),
        layer,
      ),
    );
    expect(out.get(agentX)?.model).toBe("anthropic/claude-opus-4-7");
  });

  it("overwrites a prior model when setModel is called again", async () => {
    const layer = TenantAgentOverridesServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantA, agentX, "google/gemini-3.1-flash-lite");
          yield* s.setModel(tenantA, agentX, "anthropic/claude-sonnet-4-6");
          return yield* s.getForTenant(tenantA);
        }),
        layer,
      ),
    );
    expect(out.get(agentX)?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(out.size).toBe(1);
  });

  it("clearModel removes the override row", async () => {
    const layer = TenantAgentOverridesServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantA, agentX, "anthropic/claude-opus-4-7");
          yield* s.clearModel(tenantA, agentX);
          return yield* s.getForTenant(tenantA);
        }),
        layer,
      ),
    );
    expect(out.size).toBe(0);
  });

  it("isolates tenants — one tenant's override does not leak into another", async () => {
    const layer = TenantAgentOverridesServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const s = yield* TenantAgentOverridesService;
          yield* s.setModel(tenantA, agentX, "anthropic/claude-opus-4-7");
          yield* s.setModel(tenantB, agentY, "openai/gpt-4o");
          return {
            a: yield* s.getForTenant(tenantA),
            b: yield* s.getForTenant(tenantB),
          };
        }),
        layer,
      ),
    );
    expect(Array.from(out.a.keys())).toEqual([agentX]);
    expect(Array.from(out.b.keys())).toEqual([agentY]);
    expect(out.a.get(agentX)?.model).toBe("anthropic/claude-opus-4-7");
    expect(out.b.get(agentY)?.model).toBe("openai/gpt-4o");
  });
});
