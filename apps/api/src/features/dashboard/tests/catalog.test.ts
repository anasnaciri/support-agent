import { describe, expect, it } from "vitest";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";
import { buildCatalogResponse } from "../catalog.js";

describe("buildCatalogResponse", () => {
  const catalog = buildCatalogResponse(ALL_AGENTS, ALL_TOOLS);

  it("projects every agent and tool", () => {
    expect(catalog.agents.length).toBe(ALL_AGENTS.length);
    expect(catalog.tools.length).toBe(ALL_TOOLS.length);
  });

  it("carries the fields the dashboard renders for an agent", () => {
    const triage = catalog.agents.find((a) => a.id === "support-triage");
    expect(triage).toBeDefined();
    expect(triage!.name.length).toBeGreaterThan(0);
    expect(triage!.model.length).toBeGreaterThan(0);
    expect(typeof triage!.maxTurnsPerTick).toBe("number");
    expect(Array.isArray(triage!.tools)).toBe(true);
    expect(Array.isArray(triage!.handoffs)).toBe(true);
    expect(typeof triage!.promptTemplate).toBe("string");
  });

  it("carries tool risk/permission/scope fields", () => {
    const reply = catalog.tools.find((t) => t.name === "conversation.reply");
    expect(reply).toBeDefined();
    expect(["allow", "ask", "deny"]).toContain(reply!.defaultPermission);
    expect(["read", "write", "communicate", "money"]).toContain(reply!.risk);
  });

  it("surfaces requiredConnectorScopes only when declared", () => {
    // refund.create declares write_orders; ticket.update_context declares none.
    const refund = catalog.tools.find((t) => t.name === "refund.create");
    expect(refund?.requiredConnectorScopes?.provider).toBe("shopify");
    const updateCtx = catalog.tools.find(
      (t) => t.name === "ticket.update_context",
    );
    expect(updateCtx).toBeDefined();
    expect("requiredConnectorScopes" in updateCtx!).toBe(false);
  });

  it("passes through tenant-facing metadata (displayName + tenantControl)", () => {
    const reply = catalog.tools.find((t) => t.name === "conversation.reply");
    expect(reply!.displayName).toBe("Send customer reply");
    expect(reply!.tenantControl).toBe("permission-toggle");
    expect(reply!.displayDescription).toBeTruthy();

    const refund = catalog.tools.find((t) => t.name === "refund.create");
    expect(refund!.tenantControl).toBe("refund-threshold");

    // Internal tools stay unlabelled so the dashboard never surfaces them.
    const updateCtx = catalog.tools.find(
      (t) => t.name === "ticket.update_context",
    );
    expect("tenantControl" in updateCtx!).toBe(false);
    expect("displayName" in updateCtx!).toBe(false);
  });

  it("produces a JSON-serializable snapshot (no functions/schemas leak)", () => {
    const round = JSON.parse(JSON.stringify(catalog));
    expect(round.tools[0]).not.toHaveProperty("execute");
    expect(round.tools[0]).not.toHaveProperty("inputSchema");
  });
});
