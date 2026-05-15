import { Layer } from "effect";
import {
  AgentRegistryWith,
  PermissionServiceDefault,
  ToolRegistryWith,
  type AnyTool,
} from "@support-agent/agent-core";
import { orderStatusAgent, supportTriage } from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
  shopifyGetOrder,
} from "@support-agent/tools";
import {
  AgentRuntimeDefault,
  type AgentRuntime,
  type ApprovalService,
  type AuditLogService,
  type CaseRepository,
  type ShopifyService,
  type TransactionRunner,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  AuditLogServiceLive,
  CaseRepositoryLive,
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import { parseKey } from "@support-agent/services";
import {
  LLMConfigFromEnv,
  LLMServiceLive,
  ShopifyCredentialStoreFromConnector,
  ShopifyCredentialStoreFromEnv,
  ShopifyHttpLive,
  ShopifyServiceLive,
} from "@support-agent/providers";
import { makeQueue, type PgBoss } from "./queue.js";

// ============================================================
// Public surface
// ============================================================

/**
 * Everything the worker entrypoint needs to start consuming events.
 * The `runtimeLayer` exposes `AgentRuntime` AND its tool-side dependencies
 * (`CaseRepository`, `ShopifyService`, etc.) to the outer fiber — tools
 * yield those services from inside `execute`, so the runtime alone is
 * not enough on the consumer side.
 */
export interface WorkerBootstrap {
  readonly boss: PgBoss;
  readonly runtimeLayer: Layer.Layer<
    | AgentRuntime
    | CaseRepository
    | AuditLogService
    | ApprovalService
    | ShopifyService
    | TransactionRunner
    | DbClient,
    never,
    never
  >;
  readonly shutdown: () => Promise<void>;
}

// ============================================================
// Env validation
// ============================================================

export interface BootstrapOptions {
  /**
   * If true, the bootstrap fails fast when SHOPIFY_TEST_* credentials are
   * absent. If false (the default), Shopify-backed tools won't work at
   * runtime but the worker still boots — useful for environments that
   * only handle non-Shopify events.
   */
  readonly requireShopify?: boolean;
}

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// ============================================================
// Build
// ============================================================

export const buildWorker = async (
  opts: BootstrapOptions = {},
): Promise<WorkerBootstrap> => {
  const databaseUrl = requireEnv("DATABASE_URL");

  // OPENROUTER_API_KEY is required: support-triage needs the LLM. Crashing
  // here is better than discovering it on the first message.
  requireEnv("OPENROUTER_API_KEY");

  // Pick the Shopify credential source:
  //   - If CREDENTIAL_ENCRYPTION_KEY is set, read tokens from
  //     `connector_connections` (production / managed-install path).
  //   - Otherwise fall back to SHOPIFY_TEST_* env vars (dev / single-tenant).
  // `requireShopify` only gates the env-fallback variant — when we're on
  // the connector-backed path we don't expect SHOPIFY_TEST_* to be set.
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!credKeyB64 && opts.requireShopify) {
    requireEnv("SHOPIFY_TEST_SHOP_DOMAIN");
    requireEnv("SHOPIFY_TEST_ACCESS_TOKEN");
  }

  const boss = await makeQueue({ databaseUrl });

  // ---- Live layers ----
  // DbClient is the root dep; everything db-related provides over it.
  const dbLayer = DbClientLive({ databaseUrl });

  // Repos + tx runner — all depend on DbClient.
  const repos = Layer.mergeAll(
    CaseRepositoryLive,
    AuditLogServiceLive,
    ApprovalServiceLive,
    TransactionRunnerLive,
  );

  // LLM — depends on LLMConfig.
  const llm = LLMServiceLive.pipe(Layer.provide(LLMConfigFromEnv));

  // Shopify — depends on ShopifyHttp + ShopifyCredentialStore. When the
  // encryption key is present, resolve credentials from the DB-backed
  // ConnectorCredentialStore (managed-install path); otherwise fall back
  // to env-supplied creds for single-tenant dev.
  const credentialStoreLayer = credKeyB64
    ? ShopifyCredentialStoreFromConnector().pipe(
        Layer.provide(ConnectorCredentialStoreLive(parseKey(credKeyB64))),
      )
    : ShopifyCredentialStoreFromEnv;
  const shopify = ShopifyServiceLive.pipe(
    Layer.provide(Layer.mergeAll(ShopifyHttpLive, credentialStoreLayer)),
  );

  // In-memory registries + permission policy. AgentRegistryWith /
  // ToolRegistryWith can fail with AgentAlreadyRegistered /
  // ToolAlreadyRegistered during Layer build — that would be a programmer
  // error (we control the input list), so we promote it to a defect.
  const registry = Layer.mergeAll(
    Layer.orDie(AgentRegistryWith([supportTriage, orderStatusAgent])),
    Layer.orDie(
      ToolRegistryWith([
        caseUpdateContext as AnyTool,
        caseUpdateStatus as AnyTool,
        shopifyGetOrder as AnyTool,
        agentHandoff as AnyTool,
      ]),
    ),
    PermissionServiceDefault,
  );

  // env = everything the AgentRuntime AND the tool bodies need, except
  // DbClient (which we feed in via provide below). We expose env to the
  // outer fiber because tool.execute yields its own deps (CaseRepository,
  // ShopifyService) at call time — they are NOT consumed by
  // AgentRuntimeDefault itself; they're consumed inside the tools.
  const env = Layer.mergeAll(repos, registry, llm, shopify);

  // Satisfy env's DbClient dependency.
  const envWithDb = env.pipe(Layer.provide(dbLayer));

  // Build AgentRuntime against the satisfied env.
  const agentRuntime = AgentRuntimeDefault.pipe(Layer.provide(envWithDb));

  // Expose AgentRuntime + envWithDb + dbLayer so tools can resolve their
  // own deps when the runtime calls them.
  const runtimeLayer = Layer.mergeAll(agentRuntime, envWithDb, dbLayer);

  const shutdown = async () => {
    await boss.stop({ graceful: true });
  };

  return { boss, runtimeLayer, shutdown };
};
