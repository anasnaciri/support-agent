import { Effect, Layer } from "effect";
import {
  ConnectorCredentialStore,
  LLMCredentialResolver,
  type LLMCredential,
  type LLMProvider,
} from "@support-agent/services";
import {
  LLMCredentialMissing,
  LLMCredentialRevoked,
  type ConnectorStoreDbError,
  type TenantId,
} from "@support-agent/agent-core";

const LLM_PROVIDERS: ReadonlyArray<LLMProvider> = [
  "openrouter",
  "anthropic",
  "openai",
];

const isLlmProvider = (p: string): p is LLMProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

/**
 * Live `LLMCredentialResolver` backed by `ConnectorCredentialStore`. Looks
 * up the tenant's connection rows and picks the first row whose provider is
 * one of the LLM provider values. The DB-side partial unique index
 * `connector_connections_active_llm_per_tenant_unique` guarantees there is
 * at most one **active** LLM row per tenant, so a linear scan over
 * `listForTenant` is correct and small.
 *
 * If the row is `status='revoked'` we surface `LLMCredentialRevoked` so the
 * audit log can name the provider that was disconnected — even though the
 * runtime treats it the same as `LLMCredentialMissing` (case →
 * `human_takeover`).
 */
export const LLMCredentialResolverLive = Layer.effect(
  LLMCredentialResolver,
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    return LLMCredentialResolver.of({
      resolve: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const rows = yield* store.listForTenant(tenantId);
          const llmRows = rows.filter((r) => isLlmProvider(r.provider));
          const active = llmRows.find((r) => r.status === "active");
          if (active) {
            const baseURL =
              typeof active.metadata["baseURL"] === "string"
                ? (active.metadata["baseURL"] as string)
                : undefined;
            const cred: LLMCredential = {
              provider: active.provider as LLMProvider,
              apiKey: active.accessToken,
              ...(baseURL !== undefined ? { baseURL } : {}),
            };
            return cred;
          }
          const revoked = llmRows.find((r) => r.status === "revoked");
          if (revoked) {
            return yield* Effect.fail(
              new LLMCredentialRevoked({
                tenantId,
                provider: revoked.provider,
              }),
            );
          }
          return yield* Effect.fail(new LLMCredentialMissing({ tenantId }));
        }) as Effect.Effect<
          LLMCredential,
          LLMCredentialMissing | LLMCredentialRevoked | ConnectorStoreDbError
        >,
    });
  }),
);
