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
      "shopify.find_customer_order",
      "shopify.get_customer",
      "case.update_context",
      "supplier.read_sheet_columns",
      "supplier.add_sheet_row",
      "supplier.escalate",
      "conversation.reply",
      "conversation.ask_customer",
      "knowledge.search",
      "merchant.notify",
    ]);
    expect(missingPackageAgent.promptTemplate).toContain("merchant.notify");
    expect(missingPackageAgent.tools).not.toContain("refund.create");
    expect(missingPackageAgent.tools).not.toContain("agent.handoff");
    expect(missingPackageAgent.handoffs).toEqual([]);
    expect(missingPackageAgent.maxTurnsPerTick).toBeGreaterThan(1);
    // The supplier-sheet read + write are auto-allowed inside this agent —
    // the reply still needs an operator approval, but discovering the
    // columns and logging the warehouse row shouldn't pause the case.
    expect(
      missingPackageAgent.permissionOverrides["supplier.read_sheet_columns"],
    ).toBe("allow");
    expect(missingPackageAgent.permissionOverrides["supplier.add_sheet_row"]).toBe(
      "allow",
    );
    // Escalating to the supplier parks the case in waiting_for_supplier — it
    // must be auto-allowed so it parks instead of creating an approval.
    expect(missingPackageAgent.permissionOverrides["supplier.escalate"]).toBe(
      "allow",
    );
    // BRANCH A reads the sheet's own columns before appending, rather
    // than assuming a fixed schema.
    expect(missingPackageAgent.promptTemplate).toContain(
      "supplier.read_sheet_columns",
    );
    // Prompt must describe the three decision branches so the model
    // picks the right one based on fulfillment state.
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH A");
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH B");
    expect(missingPackageAgent.promptTemplate).toContain("BRANCH C");
    // BRANCH A guards the supplier-sheet write on the runtime header.
    expect(missingPackageAgent.promptTemplate).toContain(
      "[Supplier escalation sheet:",
    );
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
