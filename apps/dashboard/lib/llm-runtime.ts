import "server-only";
import { Effect, Layer } from "effect";
import {
  ConnectorCredentialStoreLive,
  DbClientLive,
  TenantAgentOverridesServiceLive,
} from "@support-agent/db";
import {
  ConnectorCredentialStore,
  TenantAgentOverridesService,
  parseKey,
  type LLMCredential,
  type LLMProvider,
} from "@support-agent/services";
import type { AgentId, TenantId } from "@support-agent/agent-core";

const LLM_PROVIDERS: ReadonlyArray<LLMProvider> = [
  "openrouter",
  "anthropic",
  "openai",
];

const isLlmProvider = (p: string): p is LLMProvider =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

// Cached layer chain. Dashboard reads tenant LLM creds + per-agent
// overrides through this; both depend on DbClient + the credential store.
let cachedLayer:
  | Layer.Layer<ConnectorCredentialStore | TenantAgentOverridesService>
  | null
  | undefined;

const getLayer = ():
  | Layer.Layer<ConnectorCredentialStore | TenantAgentOverridesService>
  | null => {
  if (cachedLayer !== undefined) return cachedLayer;
  const databaseUrl = process.env["DATABASE_URL"];
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!databaseUrl || !credKeyB64) {
    cachedLayer = null;
    return null;
  }
  const db = DbClientLive({ databaseUrl });
  const credStore = ConnectorCredentialStoreLive(parseKey(credKeyB64));
  const overrides = TenantAgentOverridesServiceLive;
  cachedLayer = Layer.mergeAll(credStore, overrides).pipe(Layer.provide(db));
  return cachedLayer;
};

/**
 * Resolve the tenant's active LLM credential, mirroring
 * `LLMCredentialResolverLive` but exposed as a plain async function for
 * Server Components. Returns null when the tenant has no active LLM row
 * or the dashboard is not configured for BYOK (no encryption key).
 */
export const resolveTenantLlmCredential = async (
  tenantId: TenantId,
): Promise<LLMCredential | null> => {
  const layer = getLayer();
  if (!layer) return null;
  const eff = Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const rows = yield* store.listForTenant(tenantId);
    const active = rows.find(
      (r) => isLlmProvider(r.provider) && r.status === "active",
    );
    if (!active) return null;
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
  });
  return await Effect.runPromise(
    Effect.provide(eff, layer).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
      Effect.scoped,
    ),
  );
};

/**
 * Load every per-agent override row for the tenant. Used by the agent
 * detail / list pages to highlight which agents are overridden.
 */
export const loadAgentOverrides = async (
  tenantId: TenantId,
): Promise<ReadonlyMap<AgentId, string | null>> => {
  const layer = getLayer();
  if (!layer) return new Map();
  const eff = Effect.gen(function* () {
    const svc = yield* TenantAgentOverridesService;
    const map = yield* svc.getForTenant(tenantId);
    const out = new Map<AgentId, string | null>();
    for (const [id, o] of map.entries()) out.set(id, o.model);
    return out;
  });
  return await Effect.runPromise(
    Effect.provide(eff, layer).pipe(
      Effect.catchAll(() =>
        Effect.succeed(new Map() as ReadonlyMap<AgentId, string | null>),
      ),
      Effect.scoped,
    ),
  );
};
