import { describe, expect, it } from "vitest";
import {
  AgentId,
  type AgentConfig,
} from "@support-agent/agent-core";
import {
  buildSystemPrompt,
  defaultRefundPolicy,
  TenantSettings,
  DEFAULT_RETENTION_DAYS,
  type SupplierEscalationSheet,
} from "../src/index.js";

// Pure-helper tests for the runtime's system-prompt composition. Full
// end-to-end behavior lives in `apps/worker/test/agent-runtime.e2e.test.ts`;
// this file only pins the supplier-escalation header injection rule so
// changes there are caught without booting the LLM scriptedness layer.

const baseAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: AgentId("test-agent"),
  promptTemplate: "Base prompt for testing.",
  model: "anthropic/claude-3-5-sonnet",
  tools: [],
  handoffs: [],
  permissionOverrides: {},
  maxTurnsPerTick: 6,
  ...overrides,
});

const makeSettings = (
  sheet: SupplierEscalationSheet | null,
): TenantSettings =>
  new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    retentionDays: DEFAULT_RETENTION_DAYS,
    supplierEscalationSheet: sheet,
  });

describe("buildSystemPrompt", () => {
  it("returns the bare prompt when the agent doesn't use supplier.add_sheet_row", () => {
    const agent = baseAgent({ tools: ["shopify.get_order", "conversation.reply"] });
    const settings = makeSettings({
      spreadsheetId: "sheet-1",
      range: "Escalations!A:F",
      description: null,
    });
    expect(buildSystemPrompt(agent, settings)).toBe("Base prompt for testing.");
  });

  it("returns the bare prompt when the tenant has no sheet configured", () => {
    const agent = baseAgent({
      tools: ["supplier.add_sheet_row", "conversation.reply"],
    });
    expect(buildSystemPrompt(agent, makeSettings(null))).toBe(
      "Base prompt for testing.",
    );
  });

  it("returns the bare prompt when tenantSettings is null (load failure)", () => {
    const agent = baseAgent({ tools: ["supplier.add_sheet_row"] });
    expect(buildSystemPrompt(agent, null)).toBe("Base prompt for testing.");
  });

  it("appends the supplier-escalation header when both conditions hold", () => {
    const agent = baseAgent({
      tools: ["supplier.add_sheet_row", "conversation.reply"],
    });
    const settings = makeSettings({
      spreadsheetId: "abc123",
      range: "Escalations!A:F",
      description: "warehouse ops",
    });
    const got = buildSystemPrompt(agent, settings);
    expect(got).toContain("Base prompt for testing.");
    expect(got).toContain(
      "[Supplier escalation sheet: spreadsheetId=abc123, range=Escalations!A:F]",
    );
  });
});
