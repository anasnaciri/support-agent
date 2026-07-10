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
      "ticket.update_context",
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
      "order.update_shipping_address",
      "supplier.escalate",
      "tracking.lookup",
    ]) {
      expect(tools.has(remedy)).toBe(true);
    }
    // It must NOT route (no handoff) or directly drive status (the runtime
    // maps end-of-loop state → status).
    expect(tools.has("agent.handoff")).toBe(false);
    expect(tools.has("ticket.update_status")).toBe(false);
  });

  it("tells the agent gated actions are QUEUED, not executed, and to stop on its own", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    expect(p).toContain("queue");
    // The loop ends when the agent emits a final answer, not when a tool runs.
    expect(p).toContain("stop");
    // Direct-entry (2026-06-28): the agent picks the scenario itself from the
    // injected `[Resolution scenarios]` menu and records it via scenarioKey,
    // rather than being handed a single pre-chosen playbook.
    expect(p).toContain("scenario");
    expect(p).toContain("scenariokey");
  });

  it("does not allow a confident shipped reply when tracking is unsynced or unavailable on an old shipment", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    expect(p).toContain("sync_pending");
    expect(p).toContain("old shipment");
    expect(p).toContain("do not tell the customer it is simply shipped");
  });

  it("reads the tracking time scalars and anchors them in the store's policy", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // Judge late/stuck from the carrier's own relative counters rather than
    // doing date arithmetic or trusting the customer's wording.
    expect(p).toContain("transitdays");
    expect(p).toContain("dayssincelastscan");
    // No invented day count — the merchant's documented delivery window is the
    // only threshold, fetched via knowledge.search.
    expect(p).toContain("delivery window");
    expect(p).toContain("knowledge.search");
    expect(p).not.toMatch(/\b(7|14|30)\s*(\+|or more)?\s*days\b/);
    // Absence of a number is not evidence the parcel is fine.
    expect(p).toMatch(/null[\s\S]{0,300}(not evidence|cannot confirm)/);
  });

  it("prefers the store shipping profile's stated delay threshold over searching for a window", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // The runtime injects `[Store shipping profile: ...]` when the merchant has
    // configured one. It carries an exact day count, so the agent must not go
    // hunting through knowledge.search for a window that contradicts it.
    expect(p).toContain("store shipping profile");
    expect(p).toMatch(/shipping profile[\s\S]{0,400}knowledge\.search/);
    // Still no invented constant — the number comes from the merchant either
    // way, via the header when set or the policy documents when not.
    expect(p).not.toMatch(/\b(7|14|30)\s*(\+|or more)?\s*days\b/);
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
