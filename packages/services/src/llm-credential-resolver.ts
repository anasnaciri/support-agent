import { Context, Effect, Layer } from "effect";
import {
  LLMCredentialMissing,
  LLMCredentialRevoked,
  type ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

/**
 * The LLM providers a tenant can bring keys for. The agent's
 * `AgentConfig.model` string is sent to the chosen provider's SDK as-is —
 * `LLMServiceLive` does not rewrite or namespace it.
 *
 * - `openrouter` accepts the existing slash-prefixed strings
 *   (`google/gemini-3-flash-preview`, `anthropic/claude-opus-4-7`, …).
 * - `anthropic` and `openai` accept their respective native model ids
 *   (`claude-opus-4-7`, `gpt-4o`, …). If the agent's model string isn't
 *   compatible the call fails at the provider SDK and the ticket parks in
 *   `human_takeover` — surfaced as a warning on `/settings/llm`.
 */
export type LLMProvider = "openrouter" | "anthropic" | "openai";

/**
 * The model an agent runs on when the merchant has never picked one.
 *
 * This CANNOT be a single hardcoded id, which is what it used to be (every
 * agent config pinned `google/gemini-3.5-flash`). The id is passed to the
 * connected provider's SDK verbatim, so it has to be one that provider can
 * serve: OpenRouter's namespaced `vendor/model` form is meaningless to
 * Anthropic's API, and a bare `claude-…` is meaningless to OpenAI's. A merchant
 * who brought an Anthropic key and never opened the Agent page would otherwise
 * have every ticket fail at the provider and park in human takeover.
 *
 * Each entry is a floating "latest" pointer on purpose: a merchant who has
 * expressed no preference gets the current default model, not one frozen at the
 * date they signed up. A merchant who wants a specific model pins it on the
 * Agent page, and that pin always wins (see `applyOverride`).
 */
export const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<LLMProvider, string>> = {
  openrouter: "google/gemini-flash-latest",
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-luna",
};

/**
 * The default model for the tenant's connected provider, or `null` when no
 * provider is connected — in which case there is no model to name, because
 * nothing can run at all (the runtime parks on `LLMCredentialMissing`). The
 * dashboard renders that null as "Unavailable" rather than a model the merchant
 * cannot use.
 */
export const resolveDefaultModel = (
  provider: LLMProvider | null,
): string | null => (provider ? DEFAULT_MODEL_BY_PROVIDER[provider] : null);

export interface LLMCredential {
  readonly provider: LLMProvider;
  readonly apiKey: string;
  /**
   * Optional base URL override. Used for self-hosted OpenRouter / Anthropic /
   * OpenAI gateways. Stored in `connector_connections.metadata.baseURL`.
   */
  readonly baseURL?: string;
}

// ============================================================
// Tag
// ============================================================

/**
 * Per-tenant resolver for LLM provider credentials. The Live impl consults
 * `ConnectorCredentialStore` for the tenant's active LLM row. The runtime
 * calls `resolve` on every LLM tick, so the cache (per-process) is one
 * decrypted credential per active tenant — there is no global key state.
 *
 * - `LLMCredentialMissing` → tenant has no active LLM row. Runtime should
 *   park the ticket in `human_takeover` with reason `llm_credential_missing`.
 * - `LLMCredentialRevoked` → tenant had a row but it was revoked. Same
 *   handling as missing, but the audit trail names the revoked provider.
 */
export class LLMCredentialResolver extends Context.Tag("LLMCredentialResolver")<
  LLMCredentialResolver,
  {
    readonly resolve: (
      tenantId: TenantId,
    ) => Effect.Effect<
      LLMCredential,
      LLMCredentialMissing | LLMCredentialRevoked | ConnectorStoreDbError
    >;
  }
>() {}

// ============================================================
// Test Layer — pre-canned credentials by tenant
// ============================================================

/**
 * In-memory `LLMCredentialResolver` for tests. `credentials` maps tenantId →
 * credential; missing tenants fail with `LLMCredentialMissing`. Pass `null`
 * to model a tenant that has been revoked.
 */
export const LLMCredentialResolverTest = (
  credentials: ReadonlyMap<TenantId, LLMCredential | null>,
) =>
  Layer.succeed(
    LLMCredentialResolver,
    LLMCredentialResolver.of({
      resolve: (tenantId) =>
        Effect.suspend((): Effect.Effect<
          LLMCredential,
          LLMCredentialMissing | LLMCredentialRevoked
        > => {
          if (!credentials.has(tenantId)) {
            return Effect.fail(new LLMCredentialMissing({ tenantId }));
          }
          const cred = credentials.get(tenantId);
          if (cred === null) {
            return Effect.fail(
              new LLMCredentialRevoked({ tenantId, provider: "unknown" }),
            );
          }
          return Effect.succeed(cred as LLMCredential);
        }),
    }),
  );
