import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearModelCatalogCacheForTests,
  fetchAnthropicModels,
  fetchModelCatalog,
  fetchOpenAIModels,
  fetchOpenRouterModels,
} from "../src/models-catalog.js";

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("models-catalog", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __clearModelCatalogCacheForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ============================================================
  // OpenRouter
  // ============================================================

  describe("fetchOpenRouterModels", () => {
    it("normalizes the response and infers family from slash-prefixed ids", async () => {
      fetchSpy.mockResolvedValueOnce(
        okJson({
          data: [
            {
              id: "anthropic/claude-opus-4-7",
              name: "Claude Opus 4.7",
              context_length: 200_000,
              supported_parameters: ["tools", "temperature"],
            },
            {
              id: "google/gemini-2.5-flash",
              name: "Gemini 2.5 Flash",
              context_length: 1_000_000,
              supported_parameters: ["tools"],
            },
            {
              id: "openai/gpt-4o",
              name: "GPT-4o",
              context_length: 128_000,
              supported_parameters: ["tools"],
            },
          ],
        }),
      );

      const result = await fetchOpenRouterModels();
      expect(result.error).toBeUndefined();
      const families = result.entries.map((e) => e.family);
      // Sorted alphabetically by family
      expect(families).toEqual(["Claude", "Gemini", "GPT"]);
      // First entry by sort order is Claude → 200K context.
      expect(result.entries[0]?.contextLength).toBe(200_000);
    });

    it("filters out models that do not support tool calling", async () => {
      fetchSpy.mockResolvedValueOnce(
        okJson({
          data: [
            {
              id: "anthropic/claude-opus-4-7",
              name: "Claude Opus 4.7",
              supported_parameters: ["tools"],
            },
            {
              id: "openai/text-embedding-3-large",
              name: "Embedding",
              supported_parameters: ["dimensions"],
            },
          ],
        }),
      );
      const result = await fetchOpenRouterModels();
      expect(result.entries.map((e) => e.id)).toEqual([
        "anthropic/claude-opus-4-7",
      ]);
    });

    it("returns error string on non-2xx without throwing", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 503 }));
      const result = await fetchOpenRouterModels();
      expect(result.entries).toEqual([]);
      expect(result.error).toContain("503");
    });

    it("caches subsequent calls within the TTL", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchOpenRouterModels();
      await fetchOpenRouterModels();
      await fetchOpenRouterModels();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Anthropic
  // ============================================================

  describe("fetchAnthropicModels", () => {
    it("normalizes the response and sets the family to Claude", async () => {
      fetchSpy.mockResolvedValueOnce(
        okJson({
          data: [
            { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
            { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
          ],
        }),
      );
      const result = await fetchAnthropicModels("sk-ant-test");
      expect(result.entries).toHaveLength(2);
      expect(result.entries.every((e) => e.family === "Claude")).toBe(true);
    });

    it("sends the x-api-key header", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchAnthropicModels("my-key");
      const [, init] = fetchSpy.mock.calls[0]!;
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.["x-api-key"]).toBe("my-key");
    });
  });

  // ============================================================
  // OpenAI
  // ============================================================

  describe("fetchOpenAIModels", () => {
    it("filters out non-chat models (embeddings, image, audio)", async () => {
      fetchSpy.mockResolvedValueOnce(
        okJson({
          data: [
            { id: "gpt-4o" },
            { id: "gpt-4o-mini" },
            { id: "o3-mini" },
            { id: "text-embedding-3-large" },
            { id: "tts-1" },
            { id: "dall-e-3" },
          ],
        }),
      );
      const result = await fetchOpenAIModels("sk-test");
      const ids = result.entries.map((e) => e.id).sort();
      expect(ids).toEqual(["gpt-4o", "gpt-4o-mini", "o3-mini"]);
    });

    it("sends the Authorization Bearer header", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchOpenAIModels("sk-test");
      const [, init] = fetchSpy.mock.calls[0]!;
      const headers = (init as RequestInit | undefined)?.headers as
        | Record<string, string>
        | undefined;
      expect(headers?.["Authorization"]).toBe("Bearer sk-test");
    });
  });

  // ============================================================
  // Dispatcher
  // ============================================================

  describe("fetchModelCatalog", () => {
    it("routes openrouter -> OpenRouter fetcher", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchModelCatalog({ provider: "openrouter", apiKey: "x" });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("openrouter.ai");
    });

    it("routes anthropic -> Anthropic fetcher", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchModelCatalog({ provider: "anthropic", apiKey: "k" });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("api.anthropic.com");
    });

    it("routes openai -> OpenAI fetcher", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));
      await fetchModelCatalog({ provider: "openai", apiKey: "k" });
      const [url] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain("api.openai.com");
    });
  });
});
