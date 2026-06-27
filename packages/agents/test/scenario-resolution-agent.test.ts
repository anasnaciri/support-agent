import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { scenarioResolutionAgent } from "../src/scenario-resolution-agent.js";
import { ALL_AGENTS } from "../src/index.js";

describe("scenario-resolution-agent config", () => {
  it("has the autonomous-loop shape", () => {
    expect(scenarioResolutionAgent.id).toBe("scenario-resolution-agent");
    expect(scenarioResolutionAgent.mode).toBe("subagent");
    // The defining trait: it runs the autonomous reason→act→observe loop and
    // decides for itself when to stop. Every legacy agent leaves this false.
    expect(scenarioResolutionAgent.autonomousLoop).toBe(true);
    // Terminal worker — triage routes INTO it; it never hands off.
    expect(scenarioResolutionAgent.handoffs).toEqual([]);
    // It must be able to loop for many turns (gather → act → draft → stop).
    expect(scenarioResolutionAgent.maxTurnsPerTick).toBeGreaterThanOrEqual(15);
  });

  it("carries the baseline + remedy tool envelope", () => {
    const tools = new Set(scenarioResolutionAgent.tools);
    // Baseline (always-on): reads, reply, ask_customer, knowledge, context,
    // merchant heads-up.
    for (const baseline of [
      "shopify.get_order",
      "shopify.find_customer_order",
      "knowledge.search",
      "case.update_context",
      "conversation.reply",
      "conversation.ask_customer",
      "merchant.notify",
    ]) {
      expect(tools.has(baseline)).toBe(true);
    }
    // Remedy tools the scenario envelope can enable/gate.
    for (const remedy of [
      "refund.recommend",
      "refund.create",
      "discount.create",
      "supplier.escalate",
      "tracking.lookup",
    ]) {
      expect(tools.has(remedy)).toBe(true);
    }
    // It must NOT route (no handoff) or directly drive status (the runtime
    // maps end-of-loop state → status).
    expect(tools.has("agent.handoff")).toBe(false);
    expect(tools.has("case.update_status")).toBe(false);
  });

  it("tells the agent gated actions are QUEUED, not executed, and to stop on its own", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    expect(p).toContain("queue");
    // The loop ends when the agent emits a final answer, not when a tool runs.
    expect(p).toContain("stop");
    // Drives the playbook seam the runtime injects (slice 5).
    expect(p).toContain("playbook");
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([scenarioResolutionAgent]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(scenarioResolutionAgent.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(scenarioResolutionAgent);
  });

  it("is registered in ALL_AGENTS, and is the only autonomous-loop agent", () => {
    expect(ALL_AGENTS).toContain(scenarioResolutionAgent);
    const autonomous = ALL_AGENTS.filter((a) => a.autonomousLoop === true);
    expect(autonomous).toEqual([scenarioResolutionAgent]);
  });
});
