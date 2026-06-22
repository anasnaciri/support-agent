import { describe, expect, it, vi } from "vitest";
import {
  buildRephraseMessages,
  rephraseDraft,
  REPHRASE_SYSTEM,
} from "../rephrase.js";

describe("rephraseDraft — one-shot AI polish of a reply draft", () => {
  it("returns the trimmed rephrased text from the model", async () => {
    const generate = vi.fn(async () => "  Your refund is on the way.  ");
    const outcome = await rephraseDraft({
      text: "  refund coming  ",
      hasCredential: async () => true,
      generate,
    });
    expect(outcome).toEqual({
      kind: "rephrased",
      text: "Your refund is on the way.",
    });
    // model is asked to rewrite the trimmed draft
    expect(generate).toHaveBeenCalledWith("refund coming");
  });

  it("rejects an empty draft before touching credentials or the model", async () => {
    const hasCredential = vi.fn(async () => true);
    const generate = vi.fn(async () => "x");
    const outcome = await rephraseDraft({
      text: "   \n ",
      hasCredential,
      generate,
    });
    expect(outcome).toEqual({ kind: "empty_input" });
    expect(hasCredential).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns no_llm when the tenant has no AI provider configured", async () => {
    const generate = vi.fn(async () => "x");
    const outcome = await rephraseDraft({
      text: "hello",
      hasCredential: async () => false,
      generate,
    });
    expect(outcome).toEqual({ kind: "no_llm" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports failed when the model call throws", async () => {
    const outcome = await rephraseDraft({
      text: "hello",
      hasCredential: async () => true,
      generate: async () => {
        throw new Error("RateLimited");
      },
    });
    expect(outcome).toEqual({ kind: "failed", error: "RateLimited" });
  });

  it("reports failed when the model returns nothing usable", async () => {
    const outcome = await rephraseDraft({
      text: "hello",
      hasCredential: async () => true,
      generate: async () => "   ",
    });
    expect(outcome).toEqual({ kind: "failed", error: "empty_output" });
  });

  it("builds a user message that carries the draft, with a non-empty system prompt", () => {
    expect(REPHRASE_SYSTEM.length).toBeGreaterThan(0);
    const messages = buildRephraseMessages("please reship my order");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(String(messages[0]?.content)).toContain("please reship my order");
  });
});
