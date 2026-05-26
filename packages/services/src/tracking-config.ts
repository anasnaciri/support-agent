import { Context } from "effect";

/**
 * Platform-managed credentials for the upstream tracking provider
 * (17track today). NOT per-tenant — the whole platform shares one
 * 17track account and meters usage server-side. Built at worker
 * bootstrap when `SEVENTEENTRACK_API_KEY` is set in env.
 *
 * Mirrors `LLMConfig` in shape: a pure-config Tag a Live layer reads
 * once, no DB roundtrips.
 */
export interface TrackingConfigShape {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class TrackingConfig extends Context.Tag("TrackingConfig")<
  TrackingConfig,
  TrackingConfigShape
>() {}
