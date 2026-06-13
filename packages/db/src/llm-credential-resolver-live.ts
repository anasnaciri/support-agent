import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import {
  AccountOpenRouterCredentialStore,
  ConnectorCredentialStore,
  LLMCredentialResolver,
  type LLMCredential,
  type LLMProvider,
} from "@support-agent/services";
import {
  ConnectorStoreDbError,
  LLMCredentialMissing,
  LLMCredentialRevoked,
  type TenantId,
} from "@support-agent/agent-core";
import { DbClient } from "./db-client.js";
import { tenants } from "./schema.js";

const LLM_PROVIDERS: ReadonlyArray<LLMProvider> = [
  "openrouter",
  "anthropic",
  "openai",
];

const isLlmProvider = (p: string): p is LLMProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

/**
 * Live `LLMCredentialResolver` backed by workspace connector credentials plus
 * an inherited WorkOS-organization OpenRouter default. A workspace active row
 * always wins. A revoked workspace row does not block account fallback.
 *
 * The DB-side partial unique index
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
    const accountStore = yield* AccountOpenRouterCredentialStore;
    const db = yield* DbClient;
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
          const revokedWorkspace = llmRows.find((r) => r.status === "revoked");
          const orgRows = yield* Effect.tryPromise({
            try: () =>
              db
                .select({ organizationId: tenants.workosOrganizationId })
                .from(tenants)
                .where(eq(tenants.id, tenantId))
                .limit(1),
            catch: (cause) => new ConnectorStoreDbError({ cause }),
          });
          const organizationId = orgRows[0]?.organizationId ?? null;
          const account = organizationId
            ? yield* accountStore.get(organizationId)
            : null;
          if (account?.status === "active") {
            const baseURL =
              typeof account.metadata["baseURL"] === "string"
                ? (account.metadata["baseURL"] as string)
                : undefined;
            return {
              provider: "openrouter",
              apiKey: account.apiKey,
              ...(baseURL !== undefined ? { baseURL } : {}),
            } satisfies LLMCredential;
          }
          if (revokedWorkspace) {
            return yield* Effect.fail(
              new LLMCredentialRevoked({
                tenantId,
                provider: revokedWorkspace.provider,
              }),
            );
          }
          if (account?.status === "revoked") {
            return yield* Effect.fail(
              new LLMCredentialRevoked({ tenantId, provider: "openrouter" }),
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
