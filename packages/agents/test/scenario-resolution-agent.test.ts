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
      // The fulfillment-operator-tick sync: a fulfillmentOperator reporting "reshipped #TRACK" in
      // their portal message must land on the order, not just in the reply.
      "order.update_tracking",
      "fulfillment_operator.escalate",
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

  it("reads the tracking time scalars and defers the threshold to the playbook", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // The base prompt teaches how to READ the carrier's counters (no date
    // arithmetic, no trusting the customer's wording)…
    expect(p).toContain("transitdays");
    expect(p).toContain("dayssincelastscan");
    // …but never a threshold of its own: the store's number lives in the
    // delivery_issue playbook / shipping-facts header.
    expect(p).not.toMatch(/\b(7|14|30)\s*(\+|or more)?\s*days\b/);
    // Absence of a number is not evidence the parcel is fine.
    expect(p).toMatch(/null[\s\S]{0,300}(not evidence|cannot confirm)/);
  });

  it("keeps the late/stuck remedy scenario-agnostic: follow the playbook, re-stamp when it doesn't fit", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // The base prompt teaches general rules only; the remedy for a late/stuck
    // shipment is the scenario's call. It must defer to the active playbook and
    // point at re-stamping scenarioKey when that playbook doesn't cover it —
    // never unconditionally order a tool the envelope may have stripped
    // (where_is_order runs without fulfillment_operator.escalate).
    expect(p).toMatch(/late or stuck[\s\S]{0,600}playbook/);
    expect(p).toMatch(/late or stuck[\s\S]{0,600}scenariokey/);
    expect(p).not.toMatch(/late or stuck[\s\S]{0,300}open a fulfillment operator check/);
  });

  it("compares the tracking destination country against the order's shipping country", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // A `destinationCountry` that disagrees with the order's shippingAddress
    // country means the tracking number may belong to a different order — the
    // agent must not reassure the customer off that shipment.
    expect(p).toContain("destinationcountry");
    expect(p).toContain("shippingaddress");
    // Both-null is not comparable, so the check only fires when both are known.
    expect(p).toMatch(/destinationcountry[\s\S]{0,400}(differ|does not match|mismatch|different)/);
  });

  it("does not duplicate the late/stuck doctrine that lives in the delivery_issue playbook", () => {
    const p = scenarioResolutionAgent.promptTemplate.toLowerCase();
    // The doctrine (LATE/STUCK semantics, the threshold, its precedence) has
    // ONE home: the delivery_issue note (+ the shipping-facts header, which
    // states its own precedence). The base prompt only points at them, so the
    // two texts can't drift apart again.
    expect(p).toContain("store shipping facts");
    expect(p).not.toContain("gone silent for as long as");
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
