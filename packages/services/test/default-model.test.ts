import { describe, expect, it } from "vitest";
import { AgentId } from "@support-agent/agent-core";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  resolveDefaultModel,
} from "../src/llm-credential-resolver";
import { applyOverride } from "../src/agent-runtime-helpers";
import type { AgentConfig } from "@support-agent/agent-core";

// The model an agent runs on when the merchant has expressed no preference.
//
// It cannot be one hardcoded id, because the id has to be one the CONNECTED
// provider will accept: an OpenRouter-style "google/gemini-flash-latest" is a
// 404 at Anthropic's API, and a bare "claude-…" is a 404 at OpenAI's. So the
// default follows the tenant's key.

const agent = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    id: AgentId("scenario-resolution"),
    model: "google/gemini-3.5-flash",
    promptTemplate: "Base prompt.",
    tools: [],
    handoffs: [],
    permissionOverrides: {},
    ...over,
  }) as AgentConfig;

describe("resolveDefaultModel", () => {
  it("gives each provider a model that provider can actually serve", () => {
    expect(resolveDefaultModel("openrouter")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.openrouter,
    );
    expect(resolveDefaultModel("anthropic")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.anthropic,
    );
    expect(resolveDefaultModel("openai")).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
  });

  it("routes an OpenRouter default through OpenRouter's namespaced ids", () => {
    // OpenRouter addresses models as `vendor/model`; a bare id is not routable.
    expect(DEFAULT_MODEL_BY_PROVIDER.openrouter).toContain("/");
  });

  it("uses each direct provider's own native ids, never a namespaced one", () => {
    // A direct Anthropic/OpenAI key talks to that vendor's API, which has never
    // heard of the `vendor/model` form.
    expect(DEFAULT_MODEL_BY_PROVIDER.anthropic).not.toContain("/");
    expect(DEFAULT_MODEL_BY_PROVIDER.openai).not.toContain("/");
  });

  it("has no default without a key — the agent cannot run at all", () => {
    expect(resolveDefaultModel(null)).toBeNull();
  });
});

describe("applyOverride — model precedence", () => {
  const noOverrides = new Map();

  it("uses the connected provider's default when the merchant picked nothing", () => {
    const got = applyOverride(agent(), noOverrides, "claude-sonnet-5");
    expect(got.model).toBe("claude-sonnet-5");
  });

  it("lets an explicit tenant pick beat the provider default", () => {
    // The merchant chose this model on the Agent page. Their choice is the most
    // specific intent there is, and it wins.
    const overrides = new Map([
      [AgentId("scenario-resolution"), { model: "anthropic/claude-opus-4-8" }],
    ]);
    const got = applyOverride(agent(), overrides, "claude-sonnet-5");
    expect(got.model).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back to the agent's in-code model when no provider is connected", () => {
    // Nothing will run in this state anyway (the runtime parks the ticket on
    // LLMCredentialMissing), so this is a placeholder, not a routing decision.
    const got = applyOverride(agent(), noOverrides, null);
    expect(got.model).toBe("google/gemini-3.5-flash");
  });

  it("leaves the other override fields alone", () => {
    const overrides = new Map([
      [
        AgentId("scenario-resolution"),
        { systemPrompt: "Be brief.", toolPermissions: { "refund.create": "ask" } },
      ],
    ]);
    const got = applyOverride(agent(), overrides as never, "claude-sonnet-5");
    expect(got.model).toBe("claude-sonnet-5");
    expect(got.promptTemplate).toContain("Be brief.");
    expect(got.permissionOverrides["refund.create"]).toBe("ask");
  });

  it("is unchanged when called without a provider default (existing callers)", () => {
    expect(applyOverride(agent(), noOverrides).model).toBe(
      "google/gemini-3.5-flash",
    );
  });
});
