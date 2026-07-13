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
      "shopify.find_customer_order",
      "shopify.get_product",
      "shopify.get_customer",
      "ticket.update_context",
      "fulfillment_operator.escalate",
      "conversation.reply",
      "conversation.ask_customer",
      "knowledge.search",
      "merchant.notify",
    ]);
    expect(damagedProductAgent.promptTemplate).toContain("merchant.notify");
    expect(damagedProductAgent.tools).not.toContain("refund.create");
    expect(damagedProductAgent.tools).not.toContain("agent.handoff");
    expect(damagedProductAgent.handoffs).toEqual([]);
    expect(damagedProductAgent.maxTurnsPerTick).toBeGreaterThan(1);
    // A verified damaged item that warrants a REPLACEMENT escalates to the
    // fulfillment operator (they ship it + log the defect), which parks the
    // ticket in waiting_for_fulfillment_operator. It must be auto-allowed so it parks
    // instead of creating an approval — mirroring missing-package-agent.
    expect(damagedProductAgent.tools).toContain("fulfillment_operator.escalate");
    expect(damagedProductAgent.permissionOverrides["fulfillment_operator.escalate"]).toBe(
      "allow",
    );
    expect(damagedProductAgent.promptTemplate).toContain("fulfillment_operator.escalate");
    // The replacement path escalates only when the damage is verified
    // (productMatch === "match"); refunds + mismatch/uncertain still reply.
    expect(damagedProductAgent.promptTemplate).toContain("PATH REPLACEMENT");
    // When the fulfillment operator answers, the ticket re-engages here to
    // draft the customer reply.
    expect(damagedProductAgent.promptTemplate).toContain(
      "FULFILLMENT-OPERATOR-RESPONDED",
    );
    // The prompt must describe the two decision branches so the model
    // picks the right one based on whether images are present in the
    // customer's message.
    expect(damagedProductAgent.promptTemplate).toContain("BRANCH A");
    expect(damagedProductAgent.promptTemplate).toContain("BRANCH B");
    // The replacement-vs-refund decision logic is the load-bearing
    // part — keep a regression on that phrasing.
    expect(damagedProductAgent.promptTemplate).toContain("REPLACEMENT");
    expect(damagedProductAgent.promptTemplate).toContain("REFUND");
    // BRANCH A now cross-checks the photos against the product's
    // reference images and records a productMatch verdict.
    expect(damagedProductAgent.promptTemplate).toContain("shopify.get_product");
    expect(damagedProductAgent.promptTemplate).toContain("productMatch");
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
