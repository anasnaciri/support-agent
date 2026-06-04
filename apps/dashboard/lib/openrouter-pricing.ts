import "server-only";
import type { ModelPricing } from "./usage";

// OpenRouter's model list is a public endpoint (no key needed) whose entries
// carry per-token USD pricing. The usage page used to read this via
// @support-agent/providers' fetchOpenRouterModels, but that barrel pulls node
// built-ins and can't run on Workers. A plain fetch is Worker-safe, so the
// dashboard keeps its own tiny pricing lookup. Never throws — a failed fetch
// yields an empty map and the usage rows render as "unpriced".

interface OpenRouterModel {
  readonly id?: string;
  readonly pricing?: { readonly prompt?: string; readonly completion?: string };
}

export const fetchOpenRouterPricing = async (): Promise<
  ReadonlyMap<string, ModelPricing>
> => {
  const map = new Map<string, ModelPricing>();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      cache: "no-store",
    });
    if (!res.ok) return map;
    const json = (await res.json()) as { data?: ReadonlyArray<OpenRouterModel> };
    for (const m of json.data ?? []) {
      // `prompt` / `completion` are USD-per-token decimal strings.
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      if (m.id && Number.isFinite(input) && Number.isFinite(output)) {
        map.set(m.id, { inputUsdPerToken: input, outputUsdPerToken: output });
      }
    }
  } catch {
    // Network/parse failure → leave the map empty; usage renders unpriced.
  }
  return map;
};
