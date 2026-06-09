import { describe, expect, it } from "vitest";
import type {
  AgentDto,
  AgentOverrideRow,
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import {
  currentToolPermission,
  tenantConfigurableActions,
} from "../lib/catalog.js";

const tool = (over: Partial<ToolDto> & { name: string }): ToolDto => ({
  description: "d",
  risk: "communicate",
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  ...over,
});

const catalog: CatalogResponse = {
  agents: [],
  tools: [
    tool({
      name: "conversation.reply",
      displayName: "Send customer reply",
      tenantControl: "permission-toggle",
      defaultPermission: "ask",
    }),
    tool({
      name: "supplier.add_sheet_row",
      displayName: "Escalate to supplier",
      tenantControl: "permission-toggle",
      defaultPermission: "ask",
    }),
    tool({
      name: "refund.create",
      displayName: "Issue a refund",
      tenantControl: "refund-threshold",
      defaultPermission: "ask",
      risk: "money",
    }),
    tool({
      name: "shopify.get_order",
      defaultPermission: "allow",
      risk: "read",
    }), // internal — no tenantControl
  ],
};

const agent = (over: Partial<AgentDto> = {}): AgentDto => ({
  id: "refund-review-agent",
  name: "Refund Review",
  description: "d",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  promptTemplate: "p",
  tools: [
    "shopify.get_order",
    "conversation.reply",
    "supplier.add_sheet_row",
    "refund.create",
  ],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 7,
  ...over,
});

const row = (
  toolPermissions: AgentOverrideRow["toolPermissions"],
): AgentOverrideRow => ({
  agentId: "refund-review-agent",
  model: null,
  systemPrompt: null,
  toolPermissions,
});

describe("tenantConfigurableActions", () => {
  it("keeps only tools with a tenantControl, in binding order", () => {
    const actions = tenantConfigurableActions(agent(), catalog);
    expect(actions.map((a) => a.tool.name)).toEqual([
      "conversation.reply",
      "supplier.add_sheet_row",
      "refund.create",
    ]);
    // shopify.get_order (internal) is excluded entirely.
  });

  it("reports the tool default as the agent default when there's no pin", () => {
    const actions = tenantConfigurableActions(agent(), catalog);
    expect(
      actions.find((a) => a.tool.name === "conversation.reply")?.agentDefault,
    ).toBe("ask");
  });

  it("reflects an in-code permission pin as the agent default", () => {
    const actions = tenantConfigurableActions(
      agent({ permissionOverrides: { "supplier.add_sheet_row": "allow" } }),
      catalog,
    );
    expect(
      actions.find((a) => a.tool.name === "supplier.add_sheet_row")?.agentDefault,
    ).toBe("allow");
  });
});

describe("currentToolPermission", () => {
  it("returns the tenant override when present", () => {
    expect(
      currentToolPermission(
        agent(),
        catalog,
        row({ "conversation.reply": "allow" }),
        "conversation.reply",
      ),
    ).toBe("allow");
  });

  it("falls back to the agent default (pin) when no tenant override", () => {
    expect(
      currentToolPermission(
        agent({ permissionOverrides: { "supplier.add_sheet_row": "allow" } }),
        catalog,
        null,
        "supplier.add_sheet_row",
      ),
    ).toBe("allow");
  });

  it("falls back to the tool default when there's no pin or override", () => {
    expect(
      currentToolPermission(agent(), catalog, row({}), "conversation.reply"),
    ).toBe("ask");
  });

  it("returns null for a tool that isn't in the catalog", () => {
    expect(
      currentToolPermission(agent(), catalog, null, "nope.missing"),
    ).toBeNull();
  });
});
