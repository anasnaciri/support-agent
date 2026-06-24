import { describe, expect, it } from "vitest";
import type {
  AgentDto,
  AgentOverrideRow,
  CatalogResponse,
  ToolDto,
} from "@support-agent/dashboard-contracts";
import {
  capabilitiesForProvider,
  currentToolPermission,
  merchantConfigurableTools,
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
  isCustom: false,
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

describe("merchantConfigurableTools", () => {
  it("keeps only tools with a tenantControl, in catalog order", () => {
    expect(merchantConfigurableTools(catalog).map((t) => t.name)).toEqual([
      "conversation.reply",
      "supplier.add_sheet_row",
      "refund.create",
    ]);
    // shopify.get_order (internal plumbing) never reaches the matrix.
  });
});

describe("capabilitiesForProvider", () => {
  const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const scopedCatalog: CatalogResponse = {
    agents: [],
    tools: [
      tool({
        name: "supplier.read_sheet_columns",
        defaultPermission: "allow",
        requiredConnectorScopes: {
          provider: "google_sheets",
          scopes: [SHEETS_SCOPE],
        },
      }),
      tool({
        name: "supplier.add_sheet_row",
        displayName: "Escalate to supplier",
        requiredConnectorScopes: {
          provider: "google_sheets",
          scopes: [SHEETS_SCOPE],
        },
      }),
      tool({
        name: "refund.create",
        displayName: "Issue a refund",
        requiredConnectorScopes: {
          provider: "shopify",
          scopes: ["write_orders"],
        },
      }),
      tool({
        name: "shopify.get_order",
        requiredConnectorScopes: {
          provider: "shopify",
          scopes: ["read_orders"],
        },
      }),
      tool({ name: "conversation.reply" }), // no connector scopes — excluded
    ],
  };

  it("lists one friendly capability per tool, sorted by label", () => {
    expect(capabilitiesForProvider(scopedCatalog, "google_sheets")).toEqual([
      {
        tool: "supplier.add_sheet_row",
        label: "Add row",
        scope: SHEETS_SCOPE,
      },
      {
        tool: "supplier.read_sheet_columns",
        label: "Read sheet",
        scope: SHEETS_SCOPE,
      },
    ]);
  });

  it("prefers explicit override, then displayName, then a humanized name", () => {
    // refund.create -> displayName; shopify.get_order -> humanized name.
    expect(
      capabilitiesForProvider(scopedCatalog, "shopify").map((c) => c.label),
    ).toEqual(["Get order", "Issue a refund"]);
  });

  it("excludes tools with no scopes or a different provider", () => {
    const tools = capabilitiesForProvider(scopedCatalog, "shopify").map(
      (c) => c.tool,
    );
    expect(tools).not.toContain("conversation.reply");
    expect(tools).not.toContain("supplier.add_sheet_row");
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
