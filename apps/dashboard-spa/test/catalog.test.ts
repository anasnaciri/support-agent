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
  isCapabilityGranted,
  merchantConfigurableTools,
  platformCapabilitiesForProvider,
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
  defaultModel: null,
  tools: [
    tool({
      name: "conversation.reply",
      displayName: "Send customer reply",
      tenantControl: "permission-toggle",
      defaultPermission: "ask",
    }),
    tool({
      name: "fulfillment_operator.add_sheet_row",
      displayName: "Escalate to fulfillmentOperator",
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
    "fulfillment_operator.add_sheet_row",
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
      "fulfillment_operator.add_sheet_row",
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
      agent({ permissionOverrides: { "fulfillment_operator.add_sheet_row": "allow" } }),
      catalog,
    );
    expect(
      actions.find((a) => a.tool.name === "fulfillment_operator.add_sheet_row")?.agentDefault,
    ).toBe("allow");
  });
});

describe("merchantConfigurableTools", () => {
  it("keeps only tools with a tenantControl, in catalog order", () => {
    expect(merchantConfigurableTools(catalog).map((t) => t.name)).toEqual([
      "conversation.reply",
      "fulfillment_operator.add_sheet_row",
      "refund.create",
    ]);
    // shopify.get_order (internal plumbing) never reaches the matrix.
  });
});

describe("capabilitiesForProvider", () => {
  const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const scopedCatalog: CatalogResponse = {
    agents: [],
    defaultModel: null,
    tools: [
      tool({
        name: "fulfillment_operator.read_sheet_columns",
        defaultPermission: "allow",
        requiredConnectorScopes: {
          provider: "google_sheets",
          scopes: [SHEETS_SCOPE],
        },
      }),
      tool({
        name: "fulfillment_operator.add_sheet_row",
        displayName: "Escalate to fulfillmentOperator",
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
        tool: "fulfillment_operator.add_sheet_row",
        label: "Add row",
        scopes: [SHEETS_SCOPE],
      },
      {
        tool: "fulfillment_operator.read_sheet_columns",
        label: "Read sheet",
        scopes: [SHEETS_SCOPE],
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
    expect(tools).not.toContain("fulfillment_operator.add_sheet_row");
  });

  it("excludes a tool that matches the provider but requires no scope", () => {
    // shopify.get_store_info declares { provider: 'shopify', scopes: [] }
    // — the Shop query needs no Shopify scope. It must NOT appear in the
    // scope grid: with no scope to grant, it was rendered with scope "" and
    // so painted permanently "not granted" (red), which also forced the
    // misleading "Missing a capability? Reinstall" hint to always show.
    const cat: CatalogResponse = {
      agents: [],
      defaultModel: null,
      tools: [
        tool({
          name: "shopify.get_store_info",
          displayName: "Get store info",
          requiredConnectorScopes: { provider: "shopify", scopes: [] },
        }),
      ],
    };
    expect(capabilitiesForProvider(cat, "shopify")).toEqual([]);
  });
});

describe("platformCapabilitiesForProvider", () => {
  it("surfaces Shopify features that use scopes no agent tool declares", () => {
    const caps = platformCapabilitiesForProvider("shopify");
    // Restock needs write_inventory (no tool claims it); policy/page import
    // needs both read_legal_policies and read_online_store_pages; fulfillmentOperator
    // tracking edits need fulfillment-order write scopes.
    expect(caps.map((c) => c.scopes)).toEqual([
      ["write_inventory"],
      ["read_legal_policies", "read_online_store_pages"],
      [
        "write_merchant_managed_fulfillment_orders",
        "write_third_party_fulfillment_orders",
      ],
    ]);
  });

  it("returns nothing for providers without platform-only scopes", () => {
    expect(platformCapabilitiesForProvider("gmail")).toEqual([]);
    expect(platformCapabilitiesForProvider("google_sheets")).toEqual([]);
  });
});

describe("isCapabilityGranted", () => {
  const cap = (scopes: ReadonlyArray<string>) => ({
    tool: "x",
    label: "x",
    scopes,
  });

  it("is granted only when EVERY required scope is granted", () => {
    expect(
      isCapabilityGranted(
        "shopify",
        cap(["read_legal_policies", "read_online_store_pages"]),
        ["read_legal_policies", "read_online_store_pages"],
      ),
    ).toBe(true);
    expect(
      isCapabilityGranted(
        "shopify",
        cap(["read_legal_policies", "read_online_store_pages"]),
        ["read_legal_policies"], // missing the second
      ),
    ).toBe(false);
  });

  it("honors Shopify's write_X covers read_X implication", () => {
    // The connection only has write_inventory; read_inventory is implied.
    expect(
      isCapabilityGranted("shopify", cap(["read_inventory"]), [
        "write_inventory",
      ]),
    ).toBe(true);
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
        agent({ permissionOverrides: { "fulfillment_operator.add_sheet_row": "allow" } }),
        catalog,
        null,
        "fulfillment_operator.add_sheet_row",
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
