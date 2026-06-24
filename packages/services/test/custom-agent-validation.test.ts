import { describe, expect, it } from "vitest";
import type { ToolConnectorScopeRequirement } from "@support-agent/agent-core";
import {
  INSTRUCTIONS_MAX,
  NAME_MAX,
  validateCustomAgentInput,
  type CustomAgentInput,
  type CustomAgentValidationContext,
} from "../src/index.js";

const baseInput = (over: Partial<CustomAgentInput> = {}): CustomAgentInput => ({
  name: "Returns Concierge",
  description: "Handles returns.",
  instructions: "Be warm and look up the order.",
  model: "google/gemini-3.5-flash",
  tools: ["shopify.get_order", "conversation.reply"],
  handoffs: [],
  callableFrom: ["support-triage"],
  permissionOverrides: { "conversation.reply": "ask" },
  whenToUse: null,
  maxTurnsPerTick: 8,
  status: "active",
  ...over,
});

const refundScopeReq: ToolConnectorScopeRequirement = {
  provider: "shopify",
  scopes: ["write_orders"],
};

const baseCtx = (
  over: Partial<CustomAgentValidationContext> = {},
): CustomAgentValidationContext => ({
  assignableToolNames: new Set([
    "shopify.get_order",
    "conversation.reply",
    "refund.create",
    "knowledge.search",
  ]),
  knownAgentIds: new Set(["support-triage", "order-status-agent", "custom:x"]),
  selfAgentId: null,
  grantedScopesByProvider: new Map([["shopify", ["write_orders"]]]),
  toolScopeReqs: new Map([["refund.create", refundScopeReq]]),
  ...over,
});

describe("validateCustomAgentInput", () => {
  it("accepts a well-formed input", () => {
    expect(validateCustomAgentInput(baseInput(), baseCtx())).toEqual({ ok: true });
  });

  it("rejects empty / oversized name", () => {
    expect(validateCustomAgentInput(baseInput({ name: "  " }), baseCtx())).toEqual({
      ok: false,
      error: "name_required",
    });
    expect(
      validateCustomAgentInput(baseInput({ name: "x".repeat(NAME_MAX + 1) }), baseCtx()),
    ).toEqual({ ok: false, error: "name_too_long" });
  });

  it("requires description, instructions, model", () => {
    expect(
      validateCustomAgentInput(baseInput({ description: "" }), baseCtx()).ok,
    ).toBe(false);
    expect(
      validateCustomAgentInput(baseInput({ instructions: "   " }), baseCtx()),
    ).toEqual({ ok: false, error: "instructions_required" });
    expect(
      validateCustomAgentInput(
        baseInput({ instructions: "x".repeat(INSTRUCTIONS_MAX + 1) }),
        baseCtx(),
      ),
    ).toEqual({ ok: false, error: "instructions_too_long" });
    expect(
      validateCustomAgentInput(baseInput({ model: "" }), baseCtx()),
    ).toEqual({ ok: false, error: "model_required" });
  });

  it("rejects a non-assignable tool (e.g. agent.handoff)", () => {
    const res = validateCustomAgentInput(
      baseInput({ tools: ["agent.handoff"] }),
      baseCtx(),
    );
    expect(res).toEqual({ ok: false, error: "invalid_tool", detail: "agent.handoff" });
  });

  it("rejects a scope-gated tool the tenant cannot satisfy", () => {
    const res = validateCustomAgentInput(
      baseInput({ tools: ["refund.create"], permissionOverrides: {} }),
      baseCtx({ grantedScopesByProvider: new Map([["shopify", ["read_orders"]]]) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("missing_connector_scope");
      expect(res.detail).toContain("refund.create");
    }
  });

  it("accepts a scope-gated tool when write covers read (shopify hierarchy)", () => {
    const res = validateCustomAgentInput(
      baseInput({
        tools: ["refund.create"],
        permissionOverrides: {},
      }),
      baseCtx({
        toolScopeReqs: new Map([
          ["refund.create", { provider: "shopify", scopes: ["read_orders"] }],
        ]),
        grantedScopesByProvider: new Map([["shopify", ["write_orders"]]]),
      }),
    );
    expect(res).toEqual({ ok: true });
  });

  it("rejects unknown + self handoff targets", () => {
    expect(
      validateCustomAgentInput(baseInput({ handoffs: ["nope"] }), baseCtx()),
    ).toEqual({ ok: false, error: "invalid_handoff", detail: "nope" });
    expect(
      validateCustomAgentInput(
        baseInput({ handoffs: ["custom:x"] }),
        baseCtx({ selfAgentId: "custom:x" }),
      ),
    ).toEqual({ ok: false, error: "self_handoff", detail: "custom:x" });
  });

  it("rejects an unknown callableFrom source", () => {
    expect(
      validateCustomAgentInput(baseInput({ callableFrom: ["ghost"] }), baseCtx()),
    ).toEqual({ ok: false, error: "invalid_callable_from", detail: "ghost" });
  });

  it("rejects a permission for an unassigned tool or a deny value", () => {
    expect(
      validateCustomAgentInput(
        baseInput({ permissionOverrides: { "knowledge.search": "ask" } }),
        baseCtx(),
      ),
    ).toEqual({ ok: false, error: "invalid_permission", detail: "knowledge.search" });
    expect(
      validateCustomAgentInput(
        baseInput({
          permissionOverrides: { "conversation.reply": "deny" as never },
        }),
        baseCtx(),
      ),
    ).toEqual({ ok: false, error: "invalid_permission", detail: "conversation.reply" });
  });

  it("rejects an invalid status", () => {
    expect(
      validateCustomAgentInput(
        baseInput({ status: "archived" as never }),
        baseCtx(),
      ),
    ).toEqual({ ok: false, error: "invalid_status" });
  });
});
