// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { trimmedFormValuesDirty } from "../lib/unsaved-changes";
import { agentEditsDirty } from "../features/settings/AgentPage";

describe("trimmedFormValuesDirty (facts forms)", () => {
  const saved = {
    processingTime: "1-2 business days",
    deliveryTime: "7-12 days",
    shippingCost: "",
    delayedAfterDays: "14",
  };

  it("is clean for an untouched form", () => {
    expect(trimmedFormValuesDirty(saved, { ...saved })).toBe(false);
  });

  it("is dirty once a value actually changes", () => {
    expect(
      trimmedFormValuesDirty(saved, { ...saved, delayedAfterDays: "21" }),
    ).toBe(true);
    expect(
      trimmedFormValuesDirty(saved, { ...saved, shippingCost: "$4.95" }),
    ).toBe(true);
  });

  it("ignores padding the save would strip anyway", () => {
    expect(
      trimmedFormValuesDirty(saved, {
        ...saved,
        processingTime: "  1-2 business days  ",
        delayedAfterDays: " 14 ",
      }),
    ).toBe(false);
  });
});

describe("agentEditsDirty", () => {
  const base = {
    defaultModel: "google/gemini-3.5-flash",
    savedPrompt: null,
    promptText: "",
    savedModel: null,
    selectedModel: "",
  };

  it("is clean when neither the prompt nor the model has been touched", () => {
    expect(agentEditsDirty(base)).toBe(false);
  });

  it("is dirty on an unsaved prompt edit, clean again once it is undone", () => {
    expect(agentEditsDirty({ ...base, promptText: "Sign off as Acme." })).toBe(
      true,
    );
    expect(
      agentEditsDirty({
        ...base,
        savedPrompt: "Sign off as Acme.",
        promptText: "Sign off as Acme.",
      }),
    ).toBe(false);
  });

  it("ignores whitespace the prompt save would trim", () => {
    expect(
      agentEditsDirty({
        ...base,
        savedPrompt: "Sign off as Acme.",
        promptText: "  Sign off as Acme.\n",
      }),
    ).toBe(false);
  });

  it("is dirty on an unsaved model pick", () => {
    expect(agentEditsDirty({ ...base, selectedModel: "anthropic/opus" })).toBe(
      true,
    );
    expect(
      agentEditsDirty({
        ...base,
        savedModel: "anthropic/opus",
        selectedModel: "anthropic/opus",
      }),
    ).toBe(false);
  });

  it("treats picking the agent default as a reset, not an edit", () => {
    // Saving the default clears the override, so selecting it with no override
    // saved is a no-op the merchant should not be warned about.
    expect(
      agentEditsDirty({ ...base, selectedModel: base.defaultModel }),
    ).toBe(false);
    // …but selecting it while an override IS saved does change what's stored.
    expect(
      agentEditsDirty({
        ...base,
        savedModel: "anthropic/opus",
        selectedModel: base.defaultModel,
      }),
    ).toBe(true);
  });
});
