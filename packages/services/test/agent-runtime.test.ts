import { describe, expect, it } from "vitest";
import {
  AgentId,
  UNTRUSTED_PREAMBLE,
  type AgentConfig,
} from "@support-agent/agent-core";
import {
  applyOverride,
  buildSystemPrompt,
  defaultRefundPolicy,
  TenantSettings,
  DEFAULT_RETENTION_DAYS,
  toolFailureAuditDetail,
  type AgentOverride,
  type SupplierEscalationSheet,
} from "../src/index.js";

// Every system prompt is prefixed with the untrusted-content preamble
// (prompt-injection mitigation). The header-composition tests below pin the
// rest of the prompt by asserting equality against the bare body wrapped with
// this prefix.
const withPreamble = (body: string): string =>
  `${UNTRUSTED_PREAMBLE}\n\n${body}`;

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
    legalAcceptance: null,
  });

describe("buildSystemPrompt", () => {
  it("returns the bare prompt when the agent doesn't use supplier.add_sheet_row", () => {
    const agent = baseAgent({ tools: ["shopify.get_order", "conversation.reply"] });
    const settings = makeSettings({
      spreadsheetId: "sheet-1",
      range: "Escalations!A:F",
      description: null,
    });
    expect(buildSystemPrompt(agent, settings)).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("prefixes every prompt with the untrusted-content preamble", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    const got = buildSystemPrompt(agent, null);
    expect(got.startsWith(UNTRUSTED_PREAMBLE)).toBe(true);
    expect(got.toLowerCase()).toContain("untrusted");
    expect(got).toContain("Base prompt for testing.");
  });

  it("returns the bare prompt when the tenant has no sheet configured", () => {
    const agent = baseAgent({
      tools: ["supplier.add_sheet_row", "conversation.reply"],
    });
    expect(buildSystemPrompt(agent, makeSettings(null))).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("returns the bare prompt when tenantSettings is null (load failure)", () => {
    const agent = baseAgent({ tools: ["supplier.add_sheet_row"] });
    expect(buildSystemPrompt(agent, null)).toBe(
      withPreamble("Base prompt for testing."),
    );
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

  it("ignores knowledge titles when the agent doesn't use knowledge.search", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    expect(buildSystemPrompt(agent, null, ["Shipping policy"])).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("omits the knowledge-base header when the tenant has no documents", () => {
    const agent = baseAgent({ tools: ["knowledge.search"] });
    expect(buildSystemPrompt(agent, null, [])).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("appends the knowledge-base header listing titles when the agent uses knowledge.search", () => {
    const agent = baseAgent({
      tools: ["knowledge.search", "conversation.reply"],
    });
    const got = buildSystemPrompt(agent, null, [
      "Shipping policy",
      "Returns policy",
    ]);
    expect(got).toContain("Base prompt for testing.");
    expect(got).toContain(
      '[Store knowledge base — call knowledge.search to read: "Shipping policy", "Returns policy"]',
    );
  });

  it("appends both the supplier and knowledge headers when applicable", () => {
    const agent = baseAgent({
      tools: ["supplier.add_sheet_row", "knowledge.search"],
    });
    const settings = makeSettings({
      spreadsheetId: "s1",
      range: "Escalations!A:F",
      description: null,
    });
    const got = buildSystemPrompt(agent, settings, ["Shipping policy"]);
    expect(got).toContain(
      "[Supplier escalation sheet: spreadsheetId=s1, range=Escalations!A:F]",
    );
    expect(got).toContain(
      '[Store knowledge base — call knowledge.search to read: "Shipping policy"]',
    );
  });
});

describe("applyOverride — tool permissions", () => {
  const agentId = AgentId("test-agent");

  const override = (o: Partial<AgentOverride>): AgentOverride => ({
    agentId,
    model: null,
    systemPrompt: null,
    toolPermissions: null,
    updatedAt: new Date(),
    ...o,
  });

  const mapOf = (o: AgentOverride): ReadonlyMap<AgentConfig["id"], AgentOverride> =>
    new Map([[o.agentId, o]]);

  it("merges tenant toolPermissions onto the agent's permissionOverrides", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    const next = applyOverride(
      agent,
      mapOf(override({ toolPermissions: { "conversation.reply": "allow" } })),
    );
    expect(next.permissionOverrides).toEqual({ "conversation.reply": "allow" });
  });

  it("lets the tenant choice win over an in-code permission pin", () => {
    // missing-package-agent pins supplier.add_sheet_row to `allow` in code; a
    // tenant who flips it to "ask first" must win.
    const agent = baseAgent({
      tools: ["supplier.add_sheet_row"],
      permissionOverrides: { "supplier.add_sheet_row": "allow" },
    });
    const next = applyOverride(
      agent,
      mapOf(override({ toolPermissions: { "supplier.add_sheet_row": "ask" } })),
    );
    expect(next.permissionOverrides["supplier.add_sheet_row"]).toBe("ask");
  });

  it("keeps unrelated in-code pins while overriding one tool", () => {
    const agent = baseAgent({
      permissionOverrides: {
        "supplier.read_sheet_columns": "allow",
        "supplier.add_sheet_row": "allow",
      },
    });
    const next = applyOverride(
      agent,
      mapOf(override({ toolPermissions: { "supplier.add_sheet_row": "ask" } })),
    );
    expect(next.permissionOverrides).toEqual({
      "supplier.read_sheet_columns": "allow",
      "supplier.add_sheet_row": "ask",
    });
  });

  it("is a no-op (same reference) when the agent has no override row", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    expect(applyOverride(agent, new Map())).toBe(agent);
  });

  it("is a no-op (same reference) when toolPermissions is empty and nothing else is set", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    expect(applyOverride(agent, mapOf(override({ toolPermissions: {} })))).toBe(
      agent,
    );
  });

  it("applies a model override and a tool permission together", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    const next = applyOverride(
      agent,
      mapOf(
        override({
          model: "google/gemini-3.5-flash",
          toolPermissions: { "conversation.reply": "allow" },
        }),
      ),
    );
    expect(next.model).toBe("google/gemini-3.5-flash");
    expect(next.permissionOverrides).toEqual({ "conversation.reply": "allow" });
  });
});

describe("toolFailureAuditDetail", () => {
  it("captures a wrapped transport failure tag from ToolOutputInvalid issues", () => {
    expect(
      toolFailureAuditDetail({
        _tag: "ToolOutputInvalid",
        issues: ["ConversationSendFailed"],
      }),
    ).toEqual({ error: "ConversationSendFailed" });
  });

  it("captures a raw error _tag when there are no issues", () => {
    expect(toolFailureAuditDetail({ _tag: "ProviderUnavailable" })).toEqual({
      error: "ProviderUnavailable",
    });
  });

  it("strips a PII suffix (e.g. a recipient email) after the first colon", () => {
    expect(
      toolFailureAuditDetail({
        _tag: "ToolOutputInvalid",
        issues: ["recipient_not_in_thread:attacker@evil.com"],
      }),
    ).toEqual({ error: "recipient_not_in_thread" });
  });

  it("captures a non-tagged connector error via code, then message, then name", () => {
    // Regression: a bare Error used to produce {} (no reason recorded).
    expect(toolFailureAuditDetail({ code: "ETIMEDOUT", message: "connect timeout" })).toEqual({
      error: "ETIMEDOUT",
    });
    expect(toolFailureAuditDetail(new Error("550 mailbox unavailable"))).toEqual({
      error: "550 mailbox unavailable",
    });
    expect(toolFailureAuditDetail({ name: "WeirdError" })).toEqual({
      error: "WeirdError",
    });
  });

  it("returns nothing for an empty/unknown failure", () => {
    expect(toolFailureAuditDetail(null)).toEqual({});
    expect(toolFailureAuditDetail({})).toEqual({});
  });
});
