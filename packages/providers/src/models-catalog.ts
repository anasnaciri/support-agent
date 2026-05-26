/**
 * Per-provider model catalog fetchers.
 *
 * The dashboard's `/settings/agents/[id]` page calls these server-side
 * to populate the model picker. Each function returns a normalized
 * `ModelEntry[]` so the picker doesn't have to special-case providers.
 *
 * Not modeled as Effect Services because they're called once per dashboard
 * page render — no need for the Layer plumbing.
 */
import { createHash } from "node:crypto";

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
  /**
   * Short family label used to group models in the picker — e.g. "Claude",
   * "GPT", "Gemini", "Llama". Derived from the model id since not every
   * provider exposes a family field.
   */
  readonly family: string;
  readonly contextLength?: number;
  readonly pricing?: {
    readonly inputUsdPerToken: number;
    readonly outputUsdPerToken: number;
  };
}

export interface CatalogResult {
  readonly entries: ReadonlyArray<ModelEntry>;
  /** Set when the upstream call failed; entries falls back to an empty array. */
  readonly error?: string;
}

// ============================================================
// Family inference
// ============================================================

const familyFromId = (id: string): string => {
  // OpenRouter ids are slash-prefixed: `anthropic/claude-opus-4-7`,
  // `google/gemini-2.5-flash`, `openai/gpt-4o`, etc.
  if (id.includes("/")) {
    const prefix = id.slice(0, id.indexOf("/")).toLowerCase();
    if (prefix === "anthropic") return "Claude";
    if (prefix === "google") return "Gemini";
    if (prefix === "openai") return "GPT";
    if (prefix === "meta-llama" || prefix === "meta") return "Llama";
    if (prefix === "mistralai" || prefix === "mistral") return "Mistral";
    if (prefix === "deepseek") return "DeepSeek";
    if (prefix === "qwen") return "Qwen";
    if (prefix === "x-ai" || prefix === "xai") return "Grok";
    if (prefix === "amazon") return "Bedrock";
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
  // Direct provider ids — guess from a substring.
  const low = id.toLowerCase();
  if (low.startsWith("claude")) return "Claude";
  if (low.startsWith("gpt") || low.startsWith("o1") || low.startsWith("o3"))
    return "GPT";
  if (low.startsWith("gemini")) return "Gemini";
  return "Other";
};

// ============================================================
// In-memory TTL cache
// ============================================================

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

interface CacheEntry {
  readonly at: number;
  readonly result: CatalogResult;
}

const cache = new Map<string, CacheEntry>();

const hashKey = (apiKey: string | undefined): string =>
  apiKey
    ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
    : "anon";

const cacheKey = (provider: string, apiKey: string | undefined): string =>
  `${provider}:${hashKey(apiKey)}`;

const fromCache = (key: string): CatalogResult | null => {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.result;
};

const writeCache = (key: string, result: CatalogResult): void => {
  cache.set(key, { at: Date.now(), result });
};

// ============================================================
// Helpers
// ============================================================

const sortAndNormalize = (
  entries: ReadonlyArray<ModelEntry>,
): ReadonlyArray<ModelEntry> => {
  // Dedup by id — some providers list aliases that point at the same model.
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  out.sort((a, b) => {
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    return a.name.localeCompare(b.name);
  });
  return out;
};

// ============================================================
// OpenRouter — public catalog, no auth required
// ============================================================

interface OpenRouterPricing {
  readonly prompt?: string;
  readonly completion?: string;
}

interface OpenRouterModelResponse {
  readonly data?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly context_length?: number;
    readonly pricing?: OpenRouterPricing;
    readonly supported_parameters?: ReadonlyArray<string>;
  }>;
}

const parseOpenRouterPricing = (
  pricing: OpenRouterPricing | undefined,
): ModelEntry["pricing"] | undefined => {
  if (!pricing) return undefined;
  const input = Number.parseFloat(String(pricing.prompt ?? ""));
  const output = Number.parseFloat(String(pricing.completion ?? ""));
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return undefined;
  }
  return {
    inputUsdPerToken: input,
    outputUsdPerToken: output,
  };
};

export const fetchOpenRouterModels = async (
  opts: { readonly baseURL?: string } = {},
): Promise<CatalogResult> => {
  const key = cacheKey("openrouter", undefined);
  const cached = fromCache(key);
  if (cached) return cached;

  const base = opts.baseURL ?? "https://openrouter.ai/api/v1";
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const result: CatalogResult = {
        entries: [],
        error: `openrouter /models returned ${res.status}`,
      };
      writeCache(key, result);
      return result;
    }
    const json = (await res.json()) as OpenRouterModelResponse;
    const raw = json.data ?? [];
    const entries: ModelEntry[] = [];
    for (const m of raw) {
      if (!m.id) continue;
      // Only keep models that report tool-calling support — agents need it.
      const params = m.supported_parameters ?? [];
      if (
        params.length > 0 &&
        !params.includes("tools") &&
        !params.includes("tool_choice")
      ) {
        continue;
      }
      const pricing = parseOpenRouterPricing(m.pricing);
      const entry: ModelEntry = {
        id: m.id,
        name: m.name ?? m.id,
        family: familyFromId(m.id),
        ...(m.context_length !== undefined
          ? { contextLength: m.context_length }
          : {}),
        ...(pricing ? { pricing } : {}),
      };
      entries.push(entry);
    }
    const result: CatalogResult = { entries: sortAndNormalize(entries) };
    writeCache(key, result);
    return result;
  } catch (err) {
    const result: CatalogResult = {
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
    writeCache(key, result);
    return result;
  }
};

// ============================================================
// Anthropic — /v1/models (requires the tenant's key)
// ============================================================

interface AnthropicModelResponse {
  readonly data?: ReadonlyArray<{
    readonly id?: string;
    readonly display_name?: string;
  }>;
}

export const fetchAnthropicModels = async (
  apiKey: string,
  opts: { readonly baseURL?: string } = {},
): Promise<CatalogResult> => {
  const key = cacheKey("anthropic", apiKey);
  const cached = fromCache(key);
  if (cached) return cached;

  const base = opts.baseURL ?? "https://api.anthropic.com";
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const result: CatalogResult = {
        entries: [],
        error: `anthropic /v1/models returned ${res.status}`,
      };
      writeCache(key, result);
      return result;
    }
    const json = (await res.json()) as AnthropicModelResponse;
    const raw = json.data ?? [];
    const entries: ModelEntry[] = [];
    for (const m of raw) {
      if (!m.id) continue;
      entries.push({
        id: m.id,
        name: m.display_name ?? m.id,
        family: familyFromId(m.id),
      });
    }
    const result: CatalogResult = { entries: sortAndNormalize(entries) };
    writeCache(key, result);
    return result;
  } catch (err) {
    const result: CatalogResult = {
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
    writeCache(key, result);
    return result;
  }
};

// ============================================================
// OpenAI — /v1/models (requires the tenant's key)
// ============================================================

interface OpenAIModelResponse {
  readonly data?: ReadonlyArray<{
    readonly id?: string;
  }>;
}

// Conservative allowlist: OpenAI's /v1/models returns everything (embeddings,
// TTS, image, etc.). For an agent runtime we only care about models that
// support chat completions + tool calling, so we filter by prefix.
const OPENAI_CHAT_PREFIXES = [
  "gpt-",
  "o1",
  "o3",
  "chatgpt-",
] as const;

const isOpenAIChatModel = (id: string): boolean =>
  OPENAI_CHAT_PREFIXES.some((p) => id.startsWith(p));

export const fetchOpenAIModels = async (
  apiKey: string,
  opts: { readonly baseURL?: string } = {},
): Promise<CatalogResult> => {
  const key = cacheKey("openai", apiKey);
  const cached = fromCache(key);
  if (cached) return cached;

  const base = opts.baseURL ?? "https://api.openai.com";
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const result: CatalogResult = {
        entries: [],
        error: `openai /v1/models returned ${res.status}`,
      };
      writeCache(key, result);
      return result;
    }
    const json = (await res.json()) as OpenAIModelResponse;
    const raw = json.data ?? [];
    const entries: ModelEntry[] = [];
    for (const m of raw) {
      if (!m.id) continue;
      if (!isOpenAIChatModel(m.id)) continue;
      entries.push({
        id: m.id,
        name: m.id,
        family: familyFromId(m.id),
      });
    }
    const result: CatalogResult = { entries: sortAndNormalize(entries) };
    writeCache(key, result);
    return result;
  } catch (err) {
    const result: CatalogResult = {
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
    writeCache(key, result);
    return result;
  }
};

// ============================================================
// Dispatcher
// ============================================================

/**
 * Fetch the model catalog for the tenant's connected provider. Cleanly
 * routes to the per-provider fetcher above. The dashboard's
 * `/settings/agents/[id]` page calls this with the tenant's active
 * `LLMCredential`.
 */
export const fetchModelCatalog = async (input: {
  readonly provider: "openrouter" | "anthropic" | "openai";
  readonly apiKey: string;
  readonly baseURL?: string;
}): Promise<CatalogResult> => {
  switch (input.provider) {
    case "openrouter":
      return fetchOpenRouterModels(
        input.baseURL !== undefined ? { baseURL: input.baseURL } : {},
      );
    case "anthropic":
      return fetchAnthropicModels(
        input.apiKey,
        input.baseURL !== undefined ? { baseURL: input.baseURL } : {},
      );
    case "openai":
      return fetchOpenAIModels(
        input.apiKey,
        input.baseURL !== undefined ? { baseURL: input.baseURL } : {},
      );
  }
};

// Exposed for tests so they can wipe the in-process cache between cases.
export const __clearModelCatalogCacheForTests = (): void => {
  cache.clear();
};
