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
    expect(supportTriage.tools).toContain("ticket.update_context");
    expect(supportTriage.tools).toContain("agent.handoff");
    expect(supportTriage.handoffs).toContain("order-status-agent");
    expect(supportTriage.handoffs).toContain("refund-review-agent");
    expect(supportTriage.handoffs).toContain("missing-package-agent");
    expect(supportTriage.handoffs).toContain("damaged-product-agent");
    expect(supportTriage.handoffs).toContain("general-inquiry-agent");
    expect(supportTriage.maxTurnsPerTick).toBeGreaterThan(0);
    expect(supportTriage.promptTemplate.length).toBeGreaterThan(50);
  });

  it("routes delivery-reason refund/cancel requests to the delivery specialist, not refund-review", () => {
    // A refund/cancel request whose REASON is a delivery problem must be
    // classified as `missing_package` (the delivery specialist verifies the
    // claim), NOT `refund_request`. Otherwise refund-review just sizes a
    // refund without checking the delivery state.
    const p = supportTriage.promptTemplate.toLowerCase();
    expect(p).toContain("delivery problem");
    expect(p).toContain("non-delivery");
    // The routing rule must name both buckets so the model can disambiguate.
    expect(supportTriage.promptTemplate).toContain("missing_package");
    expect(supportTriage.promptTemplate).toContain("refund_request");
  });

  it("requires context notes to stay short and operational", () => {
    expect(supportTriage.promptTemplate).toContain(
      "`notes`: 25 words maximum",
    );
    expect(supportTriage.promptTemplate).toContain(
      "customer's request and the key constraint",
    );
    expect(supportTriage.promptTemplate).toContain(
      "Do not include reasoning, a timeline, or repeated details",
    );
  });

  it("does not declare any tools outside the triage-allowed set", () => {
    // Defensive — keeps the agent's scope honest. Adding real tools
    // (Shopify, email) belongs on a specialist agent, reached via
    // `agent.handoff`, not on the triage prompt itself.
    const allowed = new Set([
      "ticket.update_status",
      "ticket.update_context",
      "agent.handoff",
    ]);
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
