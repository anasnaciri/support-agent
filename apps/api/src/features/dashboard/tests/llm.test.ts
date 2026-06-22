import { describe, expect, it } from "vitest";
import { buildModelsResponse } from "../llm.js";

describe("buildModelsResponse", () => {
  it("reports disconnected when there is no credential", () => {
    const r = buildModelsResponse(null, null);
    expect(r).toEqual({
      connected: false,
      provider: null,
      entries: [],
      error: null,
      rephraseModel: null,
    });
  });

  it("carries the configured rephrase model (connected and disconnected)", () => {
    expect(buildModelsResponse(null, null, "openai/gpt-4o-mini").rephraseModel).toBe(
      "openai/gpt-4o-mini",
    );
    expect(
      buildModelsResponse(
        { provider: "openrouter", apiKey: "sk-or-…" },
        { entries: [] },
        "anthropic/claude-haiku-4-5",
      ).rephraseModel,
    ).toBe("anthropic/claude-haiku-4-5");
  });

  it("projects the catalog entries to ModelOption fields", () => {
    const r = buildModelsResponse(
      { provider: "openrouter", apiKey: "sk-or-…" },
      {
        entries: [
          {
            id: "anthropic/claude-opus-4-8",
            name: "Claude Opus 4.8",
            family: "Claude",
            contextLength: 200000,
          },
        ],
      },
    );
    expect(r.connected).toBe(true);
    expect(r.provider).toBe("openrouter");
    expect(r.error).toBeNull();
    expect(r.entries).toEqual([
      {
        id: "anthropic/claude-opus-4-8",
        name: "Claude Opus 4.8",
        family: "Claude",
        contextLength: 200000,
      },
    ]);
  });

  it("passes through an upstream fetch error with empty entries", () => {
    const r = buildModelsResponse(
      { provider: "anthropic", apiKey: "sk-ant-…" },
      { entries: [], error: "401 Unauthorized" },
    );
    expect(r.connected).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.error).toBe("401 Unauthorized");
  });
});
