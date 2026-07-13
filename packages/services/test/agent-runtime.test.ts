import { describe, expect, it } from "vitest";
import {
  AgentId,
  TicketId,
  UNTRUSTED_PREAMBLE,
  type AgentConfig,
  type DomainEvent,
} from "@support-agent/agent-core";
import type { InboundMessage } from "@support-agent/agent-core";
import {
  applyOverride,
  applyResolutionAgentEntry,
  applyScenarioEnvelope,
  applyTriageScenarioRouting,
  buildScenarioPlaybookHeader,
  buildSystemPrompt,
  WRITING_STYLE,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  defaultResolutionPolicy,
  deliveryScopeFor,
  effectiveHandoffIds,
  hasUnverifiedOrderMismatch,
  inboundReplyCandidateIds,
  buildReturnsFactsHeader,
  specialistsCallableFrom,
  TenantSettings,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  toolCallTimeoutMs,
  toolFailureAuditDetail,
  type AgentOverride,
  type ResolutionPolicy,
  type ScenarioPolicy,
  type ShippingFacts,
  type ReturnsFacts,
  type FulfillmentOperatorEscalationSheet,
} from "../src/index.js";

describe("deliveryScopeFor — ticket.resumed retry token", () => {
  const base = {
    type: "ticket.resumed" as const,
    ticketId: TicketId("c-1"),
    trigger: "dashboard_full_retry",
  };

  it("scopes a ticket.resumed by its resumeToken so a fresh retry re-runs the agent's tools", () => {
    const a: DomainEvent = { ...base, resumeToken: "tok-a" };
    const b: DomainEvent = { ...base, resumeToken: "tok-b" };
    expect(deliveryScopeFor(a)).toBe("ticket:c-1:tok-a");
    expect(deliveryScopeFor(b)).toBe("ticket:c-1:tok-b");
    // Distinct tokens → distinct scopes → no cross-retry dedup.
    expect(deliveryScopeFor(a)).not.toBe(deliveryScopeFor(b));
  });

  it("keeps the same scope for a redelivery of the SAME retry (token unchanged)", () => {
    const a1: DomainEvent = { ...base, resumeToken: "tok-a" };
    const a2: DomainEvent = { ...base, resumeToken: "tok-a" };
    // Same token → same scope → a pg-boss redelivery still can't double-send.
    expect(deliveryScopeFor(a1)).toBe(deliveryScopeFor(a2));
  });

  it("falls back to the ticket id when no resumeToken is present", () => {
    const legacy: DomainEvent = { ...base };
    expect(deliveryScopeFor(legacy)).toBe("ticket:c-1");
  });

  // Defensive backstop (prod 3428f154): the switch is exhaustive over known
  // DomainEvent types, but a malformed event reaching the runtime (a `type`
  // the switch doesn't match) must NEVER yield a bare/unscoped key. A bare key
  // collides with legacy pre-scoping markers (`conversation.reply:<draftId>`)
  // and silently dedups a fresh customer reply → the ticket auto-resolves with
  // nothing sent. So deliveryScopeFor must always return a non-empty,
  // ticket-namespaced scope.
  it("never returns a bare/empty scope, even for a malformed event type", () => {
    const malformed = {
      type: "totally.unknown" as never,
      ticketId: TicketId("c-9"),
    } as unknown as DomainEvent;
    const scope = deliveryScopeFor(malformed);
    expect(scope).toBeTruthy();
    // Namespaced by the ticket id so a send key can't collide with a bare
    // legacy marker.
    expect(scope).toBe("ticket:c-9");
  });

  it("never returns an empty scope even when no identifier is present", () => {
    const blank = { type: "totally.unknown" as never } as unknown as DomainEvent;
    expect(deliveryScopeFor(blank)).toBeTruthy();
  });
});

describe("deliveryScopeFor — fulfillment_operator.updated per escalation", () => {
  const update = (escalationId?: string): DomainEvent => ({
    type: "fulfillment_operator.updated",
    ticketId: TicketId("c-1"),
    payload: {
      fulfillmentOperatorId: "sup-1",
      note: "n",
      proposedResolution: null,
      ...(escalationId ? { escalationId } : {}),
    },
  });

  // A ticket can be escalated to the fulfillmentOperator more than once (fulfillmentOperator updates
  // always re-engage the agent, which may escalate again). Each escalation's
  // update must get its OWN scope, or the second update's reply cross-dedups
  // against the first and the agent silently sends nothing.
  it("scopes by the escalation id so a second escalation's reply is not cross-deduped", () => {
    const first = update("esc-1");
    const second = update("esc-2");
    expect(deliveryScopeFor(first)).toBe("ticket:c-1:esc:esc-1");
    expect(deliveryScopeFor(second)).toBe("ticket:c-1:esc:esc-2");
    expect(deliveryScopeFor(first)).not.toBe(deliveryScopeFor(second));
  });

  it("keeps the same scope for a redelivery of the SAME escalation's update", () => {
    expect(deliveryScopeFor(update("esc-1"))).toBe(
      deliveryScopeFor(update("esc-1")),
    );
  });

  it("falls back to the ticket id for a legacy event without an escalation id", () => {
    expect(deliveryScopeFor(update())).toBe("ticket:c-1");
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
// existing ticket (its In-Reply-To + full References chain, NOT its own id).
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
// (prompt-injection mitigation) and suffixed with the shared writing-style
// rules. The header-composition tests below pin the rest of the prompt by
// asserting equality against the bare body wrapped with both.
const withPreamble = (body: string): string =>
  `${UNTRUSTED_PREAMBLE}\n\n${body}\n\n${WRITING_STYLE}`;

// Pure-helper tests for the runtime's system-prompt composition. Full
// end-to-end behavior lives in `apps/worker/test/agent-runtime.e2e.test.ts`;
// this file only pins the fulfillment-operator-escalation header injection rule so
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
  sheet: FulfillmentOperatorEscalationSheet | null,
  shippingFacts: ShippingFacts | null = null,
  returnsFacts: ReturnsFacts | null = null,
): TenantSettings =>
  new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    discountPolicy: defaultDiscountPolicy,
    retentionDays: DEFAULT_RETENTION_DAYS,
    fulfillmentOperatorEscalationSheet: sheet,
    legalAcceptance: null,
    shippingFacts,
    returnsFacts,
  });

const fullProfile: ShippingFacts = {
  processingTime: "1–2 business days",
  deliveryTime: "7–12 days",
  shippingCost: "Free over $50, otherwise $4.95",
  customsDuties: "customer",
  delayedAfterDays: 14,
  lostPackageInvestigationDays: null,
};

const fullReturns: ReturnsFacts = {
  returnWindowDays: 30,
  returnShippingPayer: "customer",
  refundMethod: "original",
  refundProcessingTime: "5–7 business days after we receive the item",
};

describe("buildSystemPrompt", () => {
  it("resolves a playbook's action refs into the tool ids the model calls", () => {
    // The end of the chain: a merchant sees a chip ("Issue a refund"), the note
    // stores `/refund.create`, and the prompt the model reads carries the bare
    // tool id — the same text it carried before action refs existed.
    const scenario = defaultResolutionPolicy.scenarios.find(
      (s) => s.key === "damaged_product",
    )!;
    const agent = applyScenarioEnvelope(
      baseAgent({
        tools: ["conversation.reply", "refund.create", "fulfillment_operator.escalate"],
      }),
      scenario,
    );
    const prompt = buildSystemPrompt(agent, null);
    expect(prompt).toContain("conversation.ask_customer");
    expect(prompt).toContain("refund.create");
    expect(prompt).not.toContain("/refund.create");
    expect(prompt).not.toContain("/conversation.ask_customer");
    expect(prompt).not.toContain("/knowledge.search");
  });

  it("returns the bare prompt when the agent doesn't use fulfillment_operator.add_sheet_row", () => {
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
      tools: ["fulfillment_operator.add_sheet_row", "conversation.reply"],
    });
    expect(buildSystemPrompt(agent, makeSettings(null))).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("returns the bare prompt when tenantSettings is null (load failure)", () => {
    const agent = baseAgent({ tools: ["fulfillment_operator.add_sheet_row"] });
    expect(buildSystemPrompt(agent, null)).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("appends the fulfillment-operator header when both conditions hold", () => {
    const agent = baseAgent({
      tools: ["fulfillment_operator.add_sheet_row", "conversation.reply"],
    });
    const settings = makeSettings({
      spreadsheetId: "abc123",
      range: "Escalations!A:F",
      description: "warehouse ops",
    });
    const got = buildSystemPrompt(agent, settings);
    expect(got).toContain("Base prompt for testing.");
    expect(got).toContain(
      "[Fulfillment operator escalation sheet: spreadsheetId=abc123, range=Escalations!A:F]",
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
      '[Store knowledge base. Call knowledge.search to read: "Shipping policy", "Returns policy"]',
    );
  });

  it("resolves @docs references in the system prompt into knowledge.search instructions", () => {
    const docId = "123e4567-e89b-12d3-a456-426614174000";
    const agent = baseAgent({
      tools: ["knowledge.search", "conversation.reply"],
      promptTemplate: `Base prompt. Follow @docs.${docId} for international orders.`,
    });
    const got = buildSystemPrompt(agent, null, [
      { id: docId, title: "International shipping policy" },
    ]);
    expect(got).toContain("knowledge.search");
    expect(got).toContain("International shipping policy");
    expect(got).not.toContain(`@docs.${docId}`);
    expect(got).not.toContain("International shipments usually arrive");
  });

  it("omits the shipping-facts header when the agent doesn't use knowledge.search", () => {
    const agent = baseAgent({ tools: ["conversation.reply"] });
    expect(buildSystemPrompt(agent, makeSettings(null, fullProfile))).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("omits the shipping-facts header when the tenant hasn't configured one", () => {
    const agent = baseAgent({ tools: ["knowledge.search"] });
    expect(buildSystemPrompt(agent, makeSettings(null, null))).toBe(
      withPreamble("Base prompt for testing."),
    );
  });

  it("appends the shipping-facts header, carrying the merchant's delay threshold", () => {
    const agent = baseAgent({ tools: ["knowledge.search", "tracking.lookup"] });
    const got = buildSystemPrompt(agent, makeSettings(null, fullProfile));
    expect(got).toContain("[Store shipping facts");
    expect(got).toContain("1–2 business days");
    expect(got).toContain("7–12 days");
    expect(got).toContain("Free over $50, otherwise $4.95");
    // The number the agent acts on must be stated, not left to retrieval.
    expect(got).toContain("14");
    expect(got).toMatch(/delayed[\s\S]{0,120}fulfillment operator/i);
  });

  it("renders each customs payer as a merchant-facing sentence, and omits it when unset", () => {
    const agent = baseAgent({ tools: ["knowledge.search"] });
    const render = (customsDuties: ShippingFacts["customsDuties"]) =>
      buildSystemPrompt(agent, makeSettings(null, { ...fullProfile, customsDuties }));

    expect(render("customer")).toMatch(/customs[\s\S]{0,80}customer/i);
    expect(render("merchant")).toMatch(/customs[\s\S]{0,80}store/i);
    expect(render("not_applicable")).toMatch(/customs[\s\S]{0,80}not apply/i);
    expect(render(null).toLowerCase()).not.toContain("customs");
  });

  it("omits an unset shipping cost rather than printing an empty line", () => {
    const agent = baseAgent({ tools: ["knowledge.search"] });
    const got = buildSystemPrompt(
      agent,
      makeSettings(null, { ...fullProfile, shippingCost: null }),
    );
    expect(got).toContain("[Store shipping facts");
    expect(got.toLowerCase()).not.toContain("shipping cost");
  });

  it("states the lost-package threshold in the shipping header when set, omits it when null", () => {
    const agent = baseAgent({ tools: ["knowledge.search"] });
    const withLost = buildSystemPrompt(
      agent,
      makeSettings(null, { ...fullProfile, lostPackageInvestigationDays: 30 }),
    );
    // The merchant's "make the customer whole" threshold must be stated, not
    // left to retrieval — and distinguishable from the delay threshold (14).
    expect(withLost).toContain("30");
    expect(withLost).toMatch(/lost[\s\S]{0,160}(refund|reship|whole)/i);

    const withoutLost = buildSystemPrompt(
      agent,
      makeSettings(null, { ...fullProfile, lostPackageInvestigationDays: null }),
    );
    expect(withoutLost).not.toMatch(/lost/i);
  });

  it("resolves @-references in the prompt body against the tenant's facts", () => {
    // The scenario playbook bakes its notes into promptTemplate before
    // buildSystemPrompt runs, so resolving the composed body catches the notes.
    const agent = baseAgent({
      tools: ["conversation.reply"],
      promptTemplate:
        "Accept the return if it is within @returns.return_window of delivery.",
    });
    const got = buildSystemPrompt(agent, makeSettings(null, null, fullReturns));
    expect(got).toContain("30 days");
    expect(got).not.toContain("@returns.return_window");
  });

  it("falls a dangling @-reference back to its neutral phrase", () => {
    const agent = baseAgent({
      tools: ["conversation.reply"],
      promptTemplate: "Accept within @returns.return_window of delivery.",
    });
    // returnsFacts unset → the ref resolves to the fallback, never the raw token.
    const got = buildSystemPrompt(agent, makeSettings(null, null, null));
    expect(got).not.toContain("@returns.return_window");
    expect(got).toContain("our standard return window");
  });

  // ---- Returns facts header ----

  it("appends the returns-facts header only when the agent uses knowledge.search and one is configured", () => {
    const grounded = baseAgent({ tools: ["knowledge.search"] });
    const ungrounded = baseAgent({ tools: ["conversation.reply"] });
    // No tool → no header even when configured.
    expect(buildSystemPrompt(ungrounded, makeSettings(null, null, fullReturns))).toBe(
      withPreamble("Base prompt for testing."),
    );
    // Tool but no facts → no header.
    expect(buildSystemPrompt(grounded, makeSettings(null, null, null))).toBe(
      withPreamble("Base prompt for testing."),
    );
    // Both → header present with the merchant's return window.
    const got = buildSystemPrompt(grounded, makeSettings(null, null, fullReturns));
    expect(got).toContain("[Store returns");
    expect(got).toContain("30");
  });

  it("buildReturnsFactsHeader states the window and quotes optional fields, omitting unset ones", () => {
    const full = buildReturnsFactsHeader(fullReturns);
    expect(full).toContain("30");
    expect(full).toMatch(/return[\s\S]{0,40}(window|days)/i);
    expect(full).toMatch(/return shipping[\s\S]{0,60}customer/i);
    expect(full).toContain("5–7 business days after we receive the item");

    // Bare window only: the optional lines are omitted, never printed empty.
    const bare = buildReturnsFactsHeader({
      returnWindowDays: 14,
      returnShippingPayer: null,
      refundMethod: null,
      refundProcessingTime: null,
    });
    expect(bare).toContain("14");
    expect(bare.toLowerCase()).not.toContain("return shipping");
    expect(bare.toLowerCase()).not.toContain("refund method");
    expect(bare.toLowerCase()).not.toContain("processing");
  });

  it("renders each returns enum as a merchant-facing sentence", () => {
    const shipping = (payer: ReturnsFacts["returnShippingPayer"]) =>
      buildReturnsFactsHeader({ ...fullReturns, returnShippingPayer: payer });
    expect(shipping("customer")).toMatch(/return shipping[\s\S]{0,60}customer/i);
    expect(shipping("merchant")).toMatch(/return shipping[\s\S]{0,60}(store|we|free)/i);
    expect(shipping("depends")).toMatch(/return shipping[\s\S]{0,80}depends/i);

    const method = (m: ReturnsFacts["refundMethod"]) =>
      buildReturnsFactsHeader({ ...fullReturns, refundMethod: m });
    expect(method("original")).toMatch(/refund[\s\S]{0,80}original/i);
    expect(method("store_credit")).toMatch(/refund[\s\S]{0,80}store credit/i);
    expect(method("customer_choice")).toMatch(/refund[\s\S]{0,80}(choose|choice)/i);
  });

  it("appends both fulfillment-operator and knowledge headers when applicable", () => {
    const agent = baseAgent({
      tools: ["fulfillment_operator.add_sheet_row", "knowledge.search"],
    });
    const settings = makeSettings({
      spreadsheetId: "s1",
      range: "Escalations!A:F",
      description: null,
    });
    const got = buildSystemPrompt(agent, settings, ["Shipping policy"]);
    expect(got).toContain(
      "[Fulfillment operator escalation sheet: spreadsheetId=s1, range=Escalations!A:F]",
    );
    expect(got).toContain(
      '[Store knowledge base. Call knowledge.search to read: "Shipping policy"]',
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
    // missing-package-agent pins fulfillment_operator.add_sheet_row to `allow` in code; a
    // tenant who flips it to "ask first" must win.
    const agent = baseAgent({
      tools: ["fulfillment_operator.add_sheet_row"],
      permissionOverrides: { "fulfillment_operator.add_sheet_row": "allow" },
    });
    const next = applyOverride(
      agent,
      mapOf(override({ toolPermissions: { "fulfillment_operator.add_sheet_row": "ask" } })),
    );
    expect(next.permissionOverrides["fulfillment_operator.add_sheet_row"]).toBe("ask");
  });

  it("keeps unrelated in-code pins while overriding one tool", () => {
    const agent = baseAgent({
      permissionOverrides: {
        "fulfillment_operator.read_sheet_columns": "allow",
        "fulfillment_operator.add_sheet_row": "allow",
      },
    });
    const next = applyOverride(
      agent,
      mapOf(override({ toolPermissions: { "fulfillment_operator.add_sheet_row": "ask" } })),
    );
    expect(next.permissionOverrides).toEqual({
      "fulfillment_operator.read_sheet_columns": "allow",
      "fulfillment_operator.add_sheet_row": "ask",
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

describe("toolCallTimeoutMs — default wall-clock bound for tool calls", () => {
  it("defaults to a positive bound and reads/clamps the env override", () => {
    expect(toolCallTimeoutMs({})).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
    expect(DEFAULT_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "30000" })).toBe(30000);
    // clamped: below floor, above ceiling
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "10" })).toBe(1000);
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "99999999" })).toBe(300000);
    // garbage → default
    expect(toolCallTimeoutMs({ TOOL_CALL_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
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
      "order.cancel",
      "order.update_shipping_address",
      "fulfillment_operator.escalate",
    ],
  });

const scenario = (overrides: Partial<ScenarioPolicy> = {}): ScenarioPolicy => ({
  key: "delivery_issue",
  label: "Delivery problem",
  builtin: true,
  enabledActions: [{ tool: "refund.create", permission: "ask" }],
  fulfillmentOperatorMode: "escalate_and_wait",
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

  it("presents fulfillment_operator.escalate only when fulfillmentOperatorMode is not none", () => {
    const wait = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({ fulfillmentOperatorMode: "escalate_and_wait" }),
    );
    expect(wait.tools).toContain("fulfillment_operator.escalate");

    const none = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({ fulfillmentOperatorMode: "none" }),
    );
    expect(none.tools).not.toContain("fulfillment_operator.escalate");
    expect(none.permissionOverrides["fulfillment_operator.escalate"]).toBe("deny");
  });

  it("injects the playbook header (label + notes + fulfillmentOperator guidance) into the prompt", () => {
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

  it("exposes order.cancel (ask) for the cancellation scenario, denying other remedies", () => {
    const out = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({
        key: "order_cancellation",
        label: "Cancel my order",
        enabledActions: [{ tool: "order.cancel", permission: "ask" }],
        fulfillmentOperatorMode: "none",
      }),
    );
    expect(out.tools).toContain("order.cancel");
    expect(out.permissionOverrides["order.cancel"]).toBe("ask");
    // The other remedy tools are not enabled for this scenario → removed + denied.
    expect(out.tools).not.toContain("refund.create");
    expect(out.permissionOverrides["refund.create"]).toBe("deny");
    expect(out.tools).not.toContain("discount.create");
  });

  it("denies order.cancel when the scenario doesn't enable it", () => {
    const out = applyScenarioEnvelope(scenarioAgent(), scenario());
    expect(out.tools).not.toContain("order.cancel");
    expect(out.permissionOverrides["order.cancel"]).toBe("deny");
  });

  it("treats order.update_shipping_address as a gated remedy", () => {
    // Not enabled → removed + denied…
    const denied = applyScenarioEnvelope(scenarioAgent(), scenario());
    expect(denied.tools).not.toContain("order.update_shipping_address");
    expect(denied.permissionOverrides["order.update_shipping_address"]).toBe(
      "deny",
    );
    // …enabled by the shipping-address scenario → present as ask.
    const out = applyScenarioEnvelope(
      scenarioAgent(),
      scenario({
        key: "shipping_address_update",
        label: "Update my shipping address",
        enabledActions: [
          { tool: "order.update_shipping_address", permission: "ask" },
        ],
        fulfillmentOperatorMode: "escalate_and_wait",
      }),
    );
    expect(out.tools).toContain("order.update_shipping_address");
    expect(out.permissionOverrides["order.update_shipping_address"]).toBe(
      "ask",
    );
  });
});

describe("buildScenarioPlaybookHeader", () => {
  it("states that fulfillmentOperatorMode none overrides contradictory notes", () => {
    const header = buildScenarioPlaybookHeader(
      scenario({
        fulfillmentOperatorMode: "none",
        notes: "Escalate every late shipment to the fulfillmentOperator.",
      }),
    );

    expect(header).toContain(
      "This structured setting overrides any contradictory playbook note",
    );
  });

  it("omits the notes line when notes are empty", () => {
    const header = buildScenarioPlaybookHeader(
      scenario({ notes: "   " }),
    );
    expect(header).toContain("Delivery problem");
    expect(header).not.toContain("undefined");
  });

  it("tells the agent to flip the scenario when new information no longer matches", () => {
    // Re-engaged tickets run under their STAMPED scenario's playbook; without
    // this line a ticket stamped where_is_order would keep following status
    // guidance after the customer pivots to e.g. a cancellation.
    const header = buildScenarioPlaybookHeader(scenario({}));
    expect(header).toContain("different scenario");
    expect(header).toContain("scenarioKey");
  });
});

// Slice 6: triage routing to the scenario-resolution-agent behind the flag.
const triageAgent = (): AgentConfig =>
  baseAgent({
    id: AgentId("support-triage"),
    handoffs: [AgentId("order-status-agent")],
    tools: ["ticket.update_context", "agent.handoff"],
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

// Resolution-agent-direct (2026-06-28): when the resolution agent is the
// inbound entry point, it picks the scenario itself. The entry header lists the
// enabled scenarios + instructs the agent to set `scenarioKey` first (or
// escalate if none fits). Crucially it does NOT clamp tools/permissions — those
// are configured once on the agent now (per-scenario clamping is hidden).
describe("applyResolutionAgentEntry", () => {
  it("injects the scenario menu and the pick-scenario-first instruction", () => {
    const out = applyResolutionAgentEntry(scenarioAgent(), routingPolicy());
    expect(out.promptTemplate).toContain("where_is_order");
    expect(out.promptTemplate).toContain("refund_request");
    expect(out.promptTemplate).toContain("scenarioKey");
  });

  it("does NOT clamp tools or permissions (agent config governs)", () => {
    const agent = scenarioAgent();
    const out = applyResolutionAgentEntry(agent, routingPolicy());
    // Every configured tool is preserved — including remedies a scenario's
    // enabledActions would previously have stripped.
    expect(out.tools).toEqual(agent.tools);
    expect(out.permissionOverrides).toEqual(agent.permissionOverrides);
  });

  it("tells the agent to escalate (merchant.notify) when no scenario fits", () => {
    const out = applyResolutionAgentEntry(scenarioAgent(), routingPolicy());
    expect(out.promptTemplate).toContain("merchant.notify");
  });

  it("marks the scenario pick as provisional — re-stamp when evidence flips it", () => {
    // Where-is-my-order can become delivery_issue after a tracking lookup, or
    // order_cancellation after the customer's next message. The pick must not
    // lock the ticket to the first guess.
    const out = applyResolutionAgentEntry(scenarioAgent(), routingPolicy());
    expect(out.promptTemplate.toLowerCase()).toContain("provisional");
    expect(out.promptTemplate).toContain("corrected scenarioKey");
  });

  it("lists only ENABLED scenarios", () => {
    const policy: ResolutionPolicy = {
      scenarios: [
        scenario({ key: "where_is_order", label: "Where is my order?" }),
        scenario({ key: "refund_request", enabled: false }),
      ],
    };
    const out = applyResolutionAgentEntry(scenarioAgent(), policy);
    expect(out.promptTemplate).toContain("where_is_order");
    expect(out.promptTemplate).not.toContain("refund_request");
  });

  it("is a no-op when no scenarios are enabled", () => {
    const agent = scenarioAgent();
    expect(applyResolutionAgentEntry(agent, { scenarios: [] })).toBe(agent);
  });
});
