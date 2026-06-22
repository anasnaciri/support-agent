import { Effect } from "effect";
import {
  AccountOpenRouterCredentialStore,
  ConnectorCredentialStore,
  type AccountOpenRouterCredential,
  type ConnectorConnection,
  type LLMProvider,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { DbClient, tenants } from "@support-agent/db";
import { eq } from "drizzle-orm";
import type {
  LlmCredentialStatusResponse,
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
  readonly source: "workspace" | "account";
}

/**
 * The workspace override and inherited account default, without projecting
 * either plaintext key into a response.
 */
const readLlmCredentialState = (
  tenantId: string,
): Effect.Effect<
  {
    readonly workspaceRows: ReadonlyArray<ConnectorConnection>;
    readonly account: AccountOpenRouterCredential | null;
  } | null,
  never,
  ConnectorCredentialStore | AccountOpenRouterCredentialStore | DbClient
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const accounts = yield* AccountOpenRouterCredentialStore;
    const db = yield* DbClient;
    const rows = yield* store.listForTenant(TenantId(tenantId));
    const orgRows = yield* Effect.tryPromise(() =>
      db
        .select({ organizationId: tenants.workosOrganizationId })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    const organizationId = orgRows[0]?.organizationId ?? null;
    const account = organizationId ? yield* accounts.get(organizationId) : null;
    return { workspaceRows: rows, account };
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

/**
 * The effective LLM credential: active workspace row first, then active
 * account OpenRouter default. Plaintext remains server-side.
 */
export const resolveActiveLlmCredential = (
  tenantId: string,
): Effect.Effect<
  ResolvedLlmCredential | null,
  never,
  ConnectorCredentialStore | AccountOpenRouterCredentialStore | DbClient
> =>
  Effect.gen(function* () {
    const state = yield* readLlmCredentialState(tenantId);
    if (!state) return null;
    const active = state.workspaceRows.find(
      (r) => isLlmProvider(r.provider) && r.status === "active",
    );
    if (active) {
      const baseURL =
        typeof active.metadata["baseURL"] === "string"
          ? (active.metadata["baseURL"] as string)
          : undefined;
      return {
        provider: active.provider as LLMProvider,
        apiKey: active.accessToken,
        source: "workspace",
        ...(baseURL !== undefined ? { baseURL } : {}),
      } satisfies ResolvedLlmCredential;
    }
    if (state.account?.status !== "active") return null;
    const baseURL =
      typeof state.account.metadata["baseURL"] === "string"
        ? (state.account.metadata["baseURL"] as string)
        : undefined;
    return {
      provider: "openrouter",
      apiKey: state.account.apiKey,
      source: "account",
      ...(baseURL !== undefined ? { baseURL } : {}),
    } satisfies ResolvedLlmCredential;
  });

export const resolveLlmCredentialStatus = (
  tenantId: string,
): Effect.Effect<
  LlmCredentialStatusResponse,
  never,
  ConnectorCredentialStore | AccountOpenRouterCredentialStore | DbClient
> =>
  Effect.gen(function* () {
    const state = yield* readLlmCredentialState(tenantId);
    if (!state) {
      return {
        effective: null,
        workspaceOverride: null,
        accountDefault: null,
      };
    }
    const llmRows = state.workspaceRows.filter((r) => isLlmProvider(r.provider));
    const workspace =
      llmRows.find((r) => r.status === "active") ?? llmRows[0] ?? null;
    const effective =
      workspace?.status === "active"
        ? { provider: workspace.provider, source: "workspace" as const }
        : state.account?.status === "active"
          ? { provider: "openrouter", source: "account" as const }
          : null;
    return {
      effective,
      workspaceOverride: workspace
        ? {
            provider: workspace.provider,
            status: workspace.status,
            updatedAt: workspace.installedAt.toISOString(),
          }
        : null,
      accountDefault: state.account
        ? {
            provider: "openrouter",
            status: state.account.status,
            updatedAt: state.account.updatedAt.toISOString(),
          }
        : null,
    };
  });

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
  // Currently-configured "Rephrase with AI" model (a stored tenant setting,
  // independent of the connection state) so the composer can show it in the
  // model dropdown without a second fetch.
  rephraseModel: string | null = null,
): ModelsResponse => {
  if (!cred) {
    return {
      connected: false,
      provider: null,
      entries: [],
      error: null,
      rephraseModel,
    };
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
    rephraseModel,
  };
};
