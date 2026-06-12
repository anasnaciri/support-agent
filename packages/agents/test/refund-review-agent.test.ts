import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { refundReviewAgent } from "../src/refund-review-agent.js";

describe("refund-review-agent config", () => {
  it("has the expected shape", () => {
    expect(refundReviewAgent.id).toBe("refund-review-agent");
    expect(refundReviewAgent.mode).toBe("subagent");
    expect(refundReviewAgent.tools).toContain("case.update_context");
    expect(refundReviewAgent.tools).toContain("refund.create");
    expect(refundReviewAgent.tools).toContain("conversation.reply");
    expect(refundReviewAgent.handoffs).toEqual([]);
  });

  it("instructs the agent to capture structured return intent on PATH B", () => {
    const p = refundReviewAgent.promptTemplate;
    // The return-capture step + its closed vocabulary.
    expect(p).toContain("RETURN CAPTURE");
    expect(p).toContain("returnReason");
    expect(p).toContain("requestedResolution");
    // A return must never auto-refund.
    expect(p.toLowerCase()).toContain("never auto-refund a return");
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AgentRegistry, (reg) =>
          reg.resolve(refundReviewAgent.id),
        ),
        AgentRegistryWith([refundReviewAgent]),
      ),
    );
    expect(resolved).toBe(refundReviewAgent);
  });
});
