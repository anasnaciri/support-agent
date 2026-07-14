// The BYOK providers a workspace can run its agent on. Shared by the AI
// provider settings page and the setup wizard's provider step, so the two can't
// drift on which providers exist or how they're described.
//
// The server is the authority (`LLM_PROVIDER_SET` in apps/api rejects anything
// else); this is the merchant-facing half.

export const LLM_PROVIDERS = ["openrouter", "anthropic", "openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const PROVIDER_LABEL: Readonly<Record<LlmProvider, string>> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export const PROVIDER_DESCRIPTION: Readonly<Record<LlmProvider, string>> = {
  openrouter:
    "One key that works with every AI model your agents use. Recommended unless you need direct provider billing.",
  anthropic:
    "Direct Anthropic access. Your agents must use Anthropic models (claude-opus-4-7, claude-sonnet-4-6, …).",
  openai:
    "Direct OpenAI access. Your agents must use OpenAI models (gpt-5o, gpt-4o, …).",
};

export const isLlmProvider = (p: string): p is LlmProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

/**
 * Whether a model id can run on a given provider. OpenRouter routes to
 * everything; a direct provider key only works with that provider's own models
 * (its API rejects anything else), so an incompatible pick is a dead agent.
 */
export const compatibleModelsFor = (
  provider: LlmProvider,
  model: string,
): boolean => {
  if (provider === "openrouter") return true;
  if (provider === "anthropic")
    return !model.includes("/") || model.startsWith("anthropic/");
  if (provider === "openai")
    return !model.includes("/") || model.startsWith("openai/");
  return false;
};
