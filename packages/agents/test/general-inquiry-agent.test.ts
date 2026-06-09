import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  AgentRegistryWith,
} from "@support-agent/agent-core";
import { generalInquiryAgent } from "../src/general-inquiry-agent.js";

describe("general-inquiry-agent config", () => {
  it("has the expected shape", () => {
    expect(generalInquiryAgent.id).toBe("general-inquiry-agent");
    expect(generalInquiryAgent.mode).toBe("subagent");
    expect(generalInquiryAgent.provider).toBe("openrouter");
    // It grounds answers in the knowledge base + product catalog and
    // proposes the reply through the approval-gated reply tool. It must
    // NOT be able to hand off, transition status, or take any commercial
    // action (refund / discount — there is no such tool here).
    expect(generalInquiryAgent.tools).toEqual([
      "knowledge.search",
      "shopify.search_products",
      "case.update_context",
      "conversation.reply",
    ]);
    expect(generalInquiryAgent.handoffs).toEqual([]);
    expect(generalInquiryAgent.maxTurnsPerTick).toBeGreaterThan(1);
    expect(generalInquiryAgent.promptTemplate.length).toBeGreaterThan(50);
  });

  it("uses the knowledge.search tool so the system-prompt grounding header binds", () => {
    // buildSystemPrompt injects the `[Store knowledge base — …]` header
    // only when the agent's tools include `knowledge.search`. This agent
    // answers policy questions, so it must hold that tool.
    expect(generalInquiryAgent.tools).toContain("knowledge.search");
  });

  it("declares no tool that could grant a commercial action", () => {
    // Defensive — the whole point of this agent is that it cannot offer
    // discounts or issue refunds. Those tools belong elsewhere.
    const forbidden = new Set([
      "refund.create",
      "refund.recommend",
      "shopify.refund",
      "agent.handoff",
      "case.update_status",
    ]);
    for (const t of generalInquiryAgent.tools) {
      expect(forbidden.has(t)).toBe(false);
    }
  });

  it("is registrable + resolvable through AgentRegistry", async () => {
    const layer = AgentRegistryWith([generalInquiryAgent]);
    const resolved = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const reg = yield* AgentRegistry;
          return yield* reg.resolve(generalInquiryAgent.id);
        }),
        layer,
      ),
    );
    expect(resolved).toBe(generalInquiryAgent);
  });
});
