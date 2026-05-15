import { Context } from "effect";

/**
 * Configuration for the live LLM provider (OpenRouter via Vercel AI SDK).
 *
 * Kept abstract in `services` so the Tag can be consumed by any package,
 * and so test layers can inject a fake config without dragging in
 * `process.env`. The `FromEnv` factory layer lives in `packages/providers`
 * (alongside the Live impl), which is the only place that should know
 * which env vars exist.
 */
export interface LLMConfigShape {
  /** OpenRouter API key. Required when using `LLMServiceLive`. */
  readonly apiKey: string;
  /** Override OpenRouter base URL. Defaults to the provider's default. */
  readonly baseURL?: string;
  /**
   * Optional site identification headers OpenRouter recommends for
   * attribution on the openrouter.ai dashboard.
   */
  readonly siteUrl?: string;
  readonly siteName?: string;
}

export class LLMConfig extends Context.Tag("LLMConfig")<
  LLMConfig,
  LLMConfigShape
>() {}
