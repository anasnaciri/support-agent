import { Effect } from "effect";
import {
  ConnectorCredentialStore,
  type LLMProvider,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import type {
  ModelOption,
  ModelsResponse,
} from "@support-agent/dashboard-contracts";

// Resolve a tenant's active LLM credential server-side so the dashboard's
// model-picker (`GET /dashboard/models`) never receives the decrypted key —
// it only gets the resulting model list. Ports `resolveTenantLlmCredential`
// from the dashboard's lib/llm-runtime.ts.

const LLM_PROVIDERS: ReadonlyArray<LLMProvider> = [
  "openrouter",
  "anthropic",
  "openai",
];

const isLlmProvider = (p: string): p is LLMProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

export interface ResolvedLlmCredential {
  readonly provider: LLMProvider;
  readonly apiKey: string;
  readonly baseURL?: string;
}

/**
 * The tenant's active LLM credential (first active row whose provider is an
 * LLM provider), or null when none / on any store error.
 */
export const resolveActiveLlmCredential = (
  tenantId: string,
): Effect.Effect<
  ResolvedLlmCredential | null,
  never,
  ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const rows = yield* store.listForTenant(TenantId(tenantId));
    const active = rows.find(
      (r) => isLlmProvider(r.provider) && r.status === "active",
    );
    if (!active) return null;
    const baseURL =
      typeof active.metadata["baseURL"] === "string"
        ? (active.metadata["baseURL"] as string)
        : undefined;
    const cred: ResolvedLlmCredential = {
      provider: active.provider as LLMProvider,
      apiKey: active.accessToken,
      ...(baseURL !== undefined ? { baseURL } : {}),
    };
    return cred;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

/** Pure projection of a resolved credential + fetched catalog → JSON response. */
export const buildModelsResponse = (
  cred: ResolvedLlmCredential | null,
  catalog: {
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly family: string;
      readonly contextLength?: number;
    }>;
    readonly error?: string;
  } | null,
): ModelsResponse => {
  if (!cred) {
    return { connected: false, provider: null, entries: [], error: null };
  }
  const entries: ReadonlyArray<ModelOption> = (catalog?.entries ?? []).map(
    (e) => ({
      id: e.id,
      name: e.name,
      family: e.family,
      ...(e.contextLength !== undefined
        ? { contextLength: e.contextLength }
        : {}),
    }),
  );
  return {
    connected: true,
    provider: cred.provider,
    entries,
    error: catalog?.error ?? null,
  };
};
