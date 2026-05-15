import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { supportTriage } from "../src/support-triage.js";

describe("support-triage agent config", () => {
  it("has the expected shape", () => {
    expect(supportTriage.id).toBe("support-triage");
    expect(supportTriage.mode).toBe("primary");
    expect(supportTriage.provider).toBe("openrouter");
    expect(supportTriage.tools).toContain("case.update_context");
    expect(supportTriage.tools).toContain("agent.handoff");
    expect(supportTriage.handoffs).toContain("order-status-agent");
    expect(supportTriage.maxTurnsPerTick).toBeGreaterThan(0);
    expect(supportTriage.promptTemplate.length).toBeGreaterThan(50);
  });

  it("does not declare any tools outside the triage-allowed set", () => {
    // Defensive — keeps the agent's scope honest. Adding real tools
    // (Shopify, email) belongs on a specialist agent, reached via
    // `agent.handoff`, not on the triage prompt itself.
    const allowed = new Set([
      "case.update_status",
      "case.update_context",
      "agent.handoff",
    ]);
    for (const t of supportTriage.tools) {
      expect(allowed.has(t)).toBe(true);
    }
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([supportTriage]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(supportTriage.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(supportTriage);
  });
});
