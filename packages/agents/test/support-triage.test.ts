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
    expect(supportTriage.maxTurnsPerTick).toBeGreaterThan(0);
    expect(supportTriage.promptTemplate.length).toBeGreaterThan(50);
  });

  it("does not declare any tools outside the Phase 1 trivial set", () => {
    // Defensive — keeps Phase 1's scope honest. If you want to give
    // support-triage real tools (Shopify, email), drop this assertion
    // explicitly so the change is visible in review.
    const allowed = new Set(["case.update_status", "case.update_context"]);
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
