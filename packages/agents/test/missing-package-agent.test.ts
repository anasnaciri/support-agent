import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { missingPackageAgent } from "../src/missing-package-agent.js";

describe("missing-package-agent config", () => {
  it("has the expected shape", () => {
    expect(missingPackageAgent.id).toBe("missing-package-agent");
    expect(missingPackageAgent.mode).toBe("subagent");
    expect(missingPackageAgent.provider).toBe("openrouter");
    // Reads order + customer for context, draftsa reply for human approval.
    // Explicitly NOT refund.create — refunds for missing packages go
    // through refund-review-agent after the customer confirms.
    expect(missingPackageAgent.tools).toEqual([
      "shopify.get_order",
      "shopify.get_customer",
      "case.update_context",
      "conversation.reply",
    ]);
    expect(missingPackageAgent.tools).not.toContain("refund.create");
    expect(missingPackageAgent.tools).not.toContain("agent.handoff");
    expect(missingPackageAgent.handoffs).toEqual([]);
    expect(missingPackageAgent.maxTurnsPerTick).toBeGreaterThan(1);
    // Prompt must describe the three decision branches so the model
    // picks the right one based on fulfillment state.
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH A");
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH B");
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH C");
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([missingPackageAgent]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(missingPackageAgent.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(missingPackageAgent);
  });
});
