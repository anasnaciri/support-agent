import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { damagedProductAgent } from "../src/damaged-product-agent.js";

describe("damaged-product-agent config", () => {
  it("has the expected shape", () => {
    expect(damagedProductAgent.id).toBe("damaged-product-agent");
    expect(damagedProductAgent.mode).toBe("subagent");
    expect(damagedProductAgent.provider).toBe("openrouter");
    // Reads order + customer for context, drafts a reply for human
    // approval, OR asks the customer for photos when none were
    // attached. Explicitly NOT refund.create — refunds for damaged
    // products go through refund-review-agent after the customer
    // confirms.
    expect(damagedProductAgent.tools).toEqual([
      "shopify.get_order",
      "shopify.get_customer",
      "case.update_context",
      "conversation.reply",
      "conversation.ask_customer",
    ]);
    expect(damagedProductAgent.tools).not.toContain("refund.create");
    expect(damagedProductAgent.tools).not.toContain("agent.handoff");
    expect(damagedProductAgent.handoffs).toEqual([]);
    expect(damagedProductAgent.maxTurnsPerTick).toBeGreaterThan(1);
    // The prompt must describe the two decision branches so the model
    // picks the right one based on whether images are present in the
    // customer's message.
    expect(damagedProductAgent.promptTemplate).toContain("BRANCH A");
    expect(damagedProductAgent.promptTemplate).toContain("BRANCH B");
    // The replacement-vs-refund decision logic is the load-bearing
    // part — keep a regression on that phrasing.
    expect(damagedProductAgent.promptTemplate).toContain("REPLACEMENT");
    expect(damagedProductAgent.promptTemplate).toContain("REFUND");
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([damagedProductAgent]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(damagedProductAgent.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(damagedProductAgent);
  });
});
