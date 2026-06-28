import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  UNTRUSTED_PREAMBLE,
  type AgentConfig,
  type DomainEvent,
} from "@support-agent/agent-core";
import type { InboundMessage } from "@support-agent/agent-core";
import {
  applyOverride,
  applyScenarioEnvelope,
  applyTriageScenarioRouting,
  buildScenarioPlaybookHeader,
  buildSystemPrompt,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  deliveryScopeFor,
  effectiveHandoffIds,
  hasUnverifiedOrderMismatch,
  inboundReplyCandidateIds,
  specialistsCallableFrom,
  TenantSettings,
  DEFAULT_RETENTION_DAYS,
  toolFailureAuditDetail,
  type AgentOverride,
  type ResolutionPolicy,
  type ScenarioPolicy,
  type SupplierEscalationSheet,
} from "../src/index.js";

describe("deliveryScopeFor — case.resumed retry token", () => {
  const base = {
    type: "case.resumed" as const,
    caseId: CaseId("c-1"),
    trigger: "dashboard_full_retry",
  };

  it("scopes a case.resumed by its resumeToken so a fresh retry re-runs the agent's tools", () => {
    const a: DomainEvent = { ...base, resumeToken: "tok-a" };
    const b: DomainEvent = { ...base, resumeToken: "tok-b" };
    expect(deliveryScopeFor(a)).toBe("case:c-1:tok-a");
    expect(deliveryScopeFor(b)).toBe("case:c-1:tok-b");
    // Distinct tokens → distinct scopes → no cross-retry dedup.
    expect(deliveryScopeFor(a)).not.toBe(deliveryScopeFor(b));
  });

  it("keeps the same scope for a redelivery of the SAME retry (token unchanged)", () => {
    const a1: DomainEvent = { ...base, resumeToken: "tok-a" };
    const a2: DomainEvent = { ...base, resumeToken: "tok-a" };
    // Same token → same scope → a pg-boss redelivery still can't double-send.
    expect(deliveryScopeFor(a1)).toBe(deliveryScopeFor(a2));
  });

  it("falls back to the case id when no resumeToken is present", () => {
    const legacy: DomainEvent = { ...base };
    expect(deliveryScopeFor(legacy)).toBe("case:c-1");
  });

  // Defensive backstop (prod 3428f154): the switch is exhaustive over known
  // DomainEvent types, but a malformed event reaching the runtime (a `type`
  // the switch doesn't match) must NEVER yield a bare/unscoped key. A bare key
  // collides with legacy pre-scoping markers (`conversation.reply:<draftId>`)
  // and silently dedups a fresh customer reply → the case auto-resolves with
  // nothing sent. So deliveryScopeFor must always return a non-empty,
  // case-namespaced scope.
  it("never returns a bare/empty scope, even for a malformed event type", () => {
    const malformed = {
      type: "totally.unknown" as never,
      caseId: CaseId("c-9"),
    } as unknown as DomainEvent;
    const scope = deliveryScopeFor(malformed);
    expect(scope).toBeTruthy();
    // Namespaced by the case id so a send key can't collide with a bare
    // legacy marker.
    expect(scope).toBe("case:c-9");
  });

  it("never returns an empty scope even when no identifier is present", () => {
    const blank = { type: "totally.unknown" as never } as unknown as DomainEvent;
    expect(deliveryScopeFor(blank)).toBeTruthy();
  });
});

describe("hasUnverifiedOrderMismatch", () => {
  it("is true when the mismatch flag is set and identity is not verified", () => {
    expect(
      hasUnverifiedOrderMismatch({ riskFlags: ["order_customer_mismatch"] }),
    ).toBe(true);
  });

  it("is false once identity has been verified", () => {
    expect(
      hasUnverifiedOrderMismatch({
        riskFlags: ["order_customer_mismatch"],
        identityVerified: true,
      }),
    ).toBe(false);
  });

  it("is false when there is no mismatch flag", () => {
    expect(hasUnverifiedOrderMismatch({ riskFlags: ["something_else"] })).toBe(
      false,
    );
    expect(hasUnverifiedOrderMismatch({})).toBe(false);
  });
});

// The message-id candidates the runtime looks up to correlate a reply to its
// existing case (its In-Reply-To + full References chain, NOT its own id).
describe("inboundReplyCandidateIds", () => {
  const base: InboundMessage = {
    threadId: "imap:root-1" as never,
    messageId: "m2",
    from: { name: null, email: "c@x.com" },
    to: [],
    subject: "RE: hi",
    bodyText: "hi",
    bodyHtml: null,
    receivedAt: new Date(0),
    attachments: [],
  };

  it("collects In-Reply-To then every reference, deduped and bracket-trimmed", () => {
    expect(
      inboundReplyCandidateIds({
        ...base,
        inReplyTo: "<m1@h>",
        references: ["<root@h>", "<m1@h>"],
      }),
    ).toEqual(["m1@h", "root@h"]);
  });

  it("excludes the message's own id and tolerates missing headers", () => {
    expect(inboundReplyCandidateIds(base)).toEqual([]);
    expect(
      inboundReplyCandidateIds({ ...base, references: ["", "  ", "a@h"] }),
    ).toEqual(["a@h"]);
  });
});

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
    discountPolicy: defaultDiscountPolicy,
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

  it("omits the specialists roster when none are callable", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    expect(buildSystemPrompt(agent, null, [], [])).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("appends the specialists roster (trusted, outside the untrusted fence)", () => {
    const agent = baseAgent({ tools: ["agent.handoff"] });
    const got = buildSystemPrompt(agent, null, [], [
      {
        id: "custom:abc",
        name: "Returns Concierge",
        description: "Handles returns.",
        whenToUse: "When the customer wants a return.",
      },
    ]);
    expect(got).toContain("Additional specialists you can hand off to");
    expect(got).toContain("custom:abc");
    expect(got).toContain('"Returns Concierge"');
    expect(got).toContain("When the customer wants a return.");
    // The roster sits in the trusted prompt body, not inside an untrusted fence.
    expect(got.indexOf("custom:abc")).toBeGreaterThan(
      got.indexOf(UNTRUSTED_PREAMBLE),
    );
  });

  it("falls back to the description when whenToUse is null", () => {
    const agent = baseAgent({ tools: ["agent.handoff"] });
    const got = buildSystemPrompt(agent, null, [], [
      {
        id: "custom:abc",
        name: "Returns",
        description: "Handles returns.",
        whenToUse: null,
      },
    ]);
    expect(got).toContain("Handles returns.");
  });
});

describe("specialistsCallableFrom", () => {
  const all = [
    {
      id: AgentId("custom:a"),
      name: "A",
      description: "da",
      whenToUse: null,
      callableFrom: [AgentId("support-triage")],
    },
    {
      id: AgentId("custom:b"),
      name: "B",
      description: "db",
      whenToUse: "use b",
      callableFrom: [AgentId("order-status-agent")],
    },
  ];

  it("returns only the specialists callable from the given agent", () => {
    const got = specialistsCallableFrom(all, "support-triage");
    expect(got.map((s) => s.id)).toEqual(["custom:a"]);
  });

  it("returns an empty list when none opted in", () => {
    expect(specialistsCallableFrom(all, "refund-review-agent")).toEqual([]);
  });
});

describe("effectiveHandoffIds", () => {
  const specialists = [
    {
      id: AgentId("custom:a"),
      callableFrom: [AgentId("support-triage")],
    },
    {
      id: AgentId("custom:b"),
      callableFrom: [AgentId("order-status-agent")],
    },
  ];

  it("unions static handoffs with custom inbound opt-ins", () => {
    const agent = {
      id: AgentId("support-triage"),
      handoffs: [AgentId("order-status-agent")],
    };
    const got = effectiveHandoffIds(agent, specialists);
    expect([...got].sort()).toEqual(["custom:a", "order-status-agent"]);
  });

  it("omits custom agents that didn't opt into this caller", () => {
    const agent = { id: AgentId("refund-review-agent"), handoffs: [] };
    expect([...effectiveHandoffIds(agent, specialists)]).toEqual([]);
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

// Scenario envelope (slice 5): clamp an autonomous agent's tools + permissions
// to a scenario and inject the playbook header.
const scenarioAgent = (): AgentConfig =>
  baseAgent({
    autonomousLoop: true,
    tools: [
      "shopify.get_order",
      "knowledge.search",
      "conversation.reply",
      "merchant.notify",
      "refund.recommend",
      "refund.create",
      "discount.create",
      "supplier.escalate",
    ],
  });

const scenario = (overrides: Partial<ScenarioPolicy> = {}): ScenarioPolicy => ({
  key: "delivery_issue",
  label: "Delivery problem",
  builtin: true,
  enabledActions: [{ tool: "refund.create", permission: "ask" }],
  supplierMode: "escalate_and_wait",
  notes: "Check tracking before offering anything.",
  ...overrides,
});

describe("applyScenarioEnvelope", () => {
  it("drops a remedy tool the scenario didn't enable and denies it", () => {
    const out = applyScenarioEnvelope(scenarioAgent(), scenario());
    // refund.create enabled (ask); discount.create NOT enabled → removed + denied.
    expect(out.tools).toContain("refund.create");
    expect(out.permissionOverrides["refund.create"]).toBe("ask");
    expect(out.tools).not.toContain("discount.create");
    expect(out.permissionOverrides["discount.create"]).toBe("deny");
  });

  it("always keeps baseline tools (reads, comms, knowledge, recommend, notify)", () => {
    const out = applyScenarioEnvelope(scenarioAgent(), scenario());
    for (const baseline of [
      "shopify.get_order",
      "knowledge.search",
      "conversation.reply",
      "merchant.notify",
      "refund.recommend",
    ]) {
      expect(out.tools).toContain(baseline);
    }
  });

  it("presents supplier.escalate only when supplierMode is not none", () => {
    const wait = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({ supplierMode: "escalate_and_wait" }),
    );
    expect(wait.tools).toContain("supplier.escalate");

    const none = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({ supplierMode: "none" }),
    );
    expect(none.tools).not.toContain("supplier.escalate");
    expect(none.permissionOverrides["supplier.escalate"]).toBe("deny");
  });

  it("injects the playbook header (label + notes + supplier guidance) into the prompt", () => {
    const out = applyScenarioEnvelope(scenarioAgent(), scenario());
    expect(out.promptTemplate).toContain("Scenario playbook");
    expect(out.promptTemplate).toContain("Delivery problem");
    expect(out.promptTemplate).toContain("Check tracking before offering anything.");
    // escalate_and_wait → "WAIT" guidance.
    expect(out.promptTemplate).toContain("WAIT");
  });

  it("enables an action with its configured allow permission", () => {
    const out = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({
        enabledActions: [
          { tool: "refund.create", permission: "allow" },
          { tool: "discount.create", permission: "ask" },
        ],
      }),
    );
    expect(out.permissionOverrides["refund.create"]).toBe("allow");
    expect(out.tools).toContain("discount.create");
    expect(out.permissionOverrides["discount.create"]).toBe("ask");
  });
});

describe("buildScenarioPlaybookHeader", () => {
  it("omits the notes line when notes are empty", () => {
    const header = buildScenarioPlaybookHeader(
      scenario({ notes: "   " }),
    );
    expect(header).toContain("Delivery problem");
    expect(header).not.toContain("undefined");
  });
});

// Slice 6: triage routing to the scenario-resolution-agent behind the flag.
const triageAgent = (): AgentConfig =>
  baseAgent({
    id: AgentId("support-triage"),
    handoffs: [AgentId("order-status-agent")],
    tools: ["case.update_context", "agent.handoff"],
  });

const routingPolicy = (): ResolutionPolicy => ({
  scenarios: [
    scenario({
      key: "where_is_order",
      label: "Where is my order?",
      recognition: "Customer asks where their order is.",
    }),
    scenario({
      key: "refund_request",
      label: "Refund request",
      recognition: "Customer wants their money back.",
    }),
  ],
});

describe("applyTriageScenarioRouting", () => {
  it("adds the resolution agent to handoffs and injects the routing header", () => {
    const out = applyTriageScenarioRouting(triageAgent(), routingPolicy());
    expect(out.handoffs.map((h) => h as string)).toContain(
      "scenario-resolution-agent",
    );
    // Original handoffs preserved.
    expect(out.handoffs.map((h) => h as string)).toContain("order-status-agent");
    // Header lists each scenario key + the routing instruction.
    expect(out.promptTemplate).toContain("Resolution scenarios");
    expect(out.promptTemplate).toContain("where_is_order");
    expect(out.promptTemplate).toContain("refund_request");
    expect(out.promptTemplate).toContain("scenarioKey");
    expect(out.promptTemplate).toContain("scenario-resolution-agent");
  });

  it("does not duplicate the resolution agent if already a handoff target", () => {
    const agent = baseAgent({
      id: AgentId("support-triage"),
      handoffs: [AgentId("scenario-resolution-agent")],
    });
    const out = applyTriageScenarioRouting(agent, routingPolicy());
    expect(
      out.handoffs.filter((h) => (h as string) === "scenario-resolution-agent"),
    ).toHaveLength(1);
  });

  it("is a no-op when the policy has no scenarios", () => {
    const agent = triageAgent();
    const out = applyTriageScenarioRouting(agent, { scenarios: [] });
    expect(out).toBe(agent);
  });

  it("offers only ENABLED scenarios — a disabled one is not listed for triage", () => {
    const policy: ResolutionPolicy = {
      scenarios: [
        scenario({ key: "where_is_order", label: "Where is my order?" }),
        scenario({
          key: "refund_request",
          label: "Refund request",
          enabled: false,
        }),
      ],
    };
    const out = applyTriageScenarioRouting(triageAgent(), policy);
    expect(out.promptTemplate).toContain("where_is_order");
    expect(out.promptTemplate).not.toContain("refund_request");
  });

  it("is a no-op when every scenario is disabled (routes as if the agent were off)", () => {
    const agent = triageAgent();
    const policy: ResolutionPolicy = {
      scenarios: [scenario({ key: "where_is_order", enabled: false })],
    };
    const out = applyTriageScenarioRouting(agent, policy);
    expect(out).toBe(agent);
  });
});
