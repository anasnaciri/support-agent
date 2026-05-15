import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { orderStatusAgent } from "../src/order-status-agent.js";

describe("order-status-agent config", () => {
  it("has the expected shape", () => {
    expect(orderStatusAgent.id).toBe("order-status-agent");
    expect(orderStatusAgent.mode).toBe("subagent");
    expect(orderStatusAgent.provider).toBe("openrouter");
    // It must be able to look up the order AND record context patches; it
    // must not be able to hand off (terminal specialist) or transition
    // status (the runtime auto-resolves on final_message).
    expect(orderStatusAgent.tools).toEqual([
      "shopify.get_order",
      "case.update_context",
    ]);
    expect(orderStatusAgent.handoffs).toEqual([]);
    expect(orderStatusAgent.maxTurnsPerTick).toBeGreaterThan(1);
    expect(orderStatusAgent.promptTemplate.length).toBeGreaterThan(50);
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([orderStatusAgent]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(orderStatusAgent.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(orderStatusAgent);
  });
});
