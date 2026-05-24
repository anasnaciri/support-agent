import { Layer } from "effect";
import {
  AgentRegistryWith,
  ToolRegistryWith,
} from "@support-agent/agent-core";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";
import {
  AgentRuntimeDefault,
  ApprovalLinkConfig,
  ConversationServiceTest,
  PermissionServiceLive,
  PlatformMailServiceTest,
  type AgentRuntime,
  type ApprovalService,
  type AuditLogService,
  type CaseRepository,
  type ConversationService,
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
  LLMCredentialResolverLive,
  TenantAgentOverridesServiceLive,
  TenantRepositoryLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import { parseKey } from "@support-agent/services";
import {
  GmailConversationLive,
  LLMConfigFromEnv,
  LLMCredentialResolverFromLLMConfig,
  LLMServiceLive,
  PlatformMailServiceLive,
  ResendConfigFromEnv,
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
    | ConversationService
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

  // BYOK: in production the LLM credential is per-tenant, read from
  // `connector_connections` via LLMCredentialResolverLive — that requires
  // CREDENTIAL_ENCRYPTION_KEY. In single-tenant dev we fall back to the
  // OPENROUTER_API_KEY env layer (LLMCredentialResolverFromLLMConfig) so
  // the worker still boots without a DB-backed key. One of the two MUST be
  // set; otherwise crash here rather than discovering it on the first
  // message.
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  const hasDevOpenrouter = Boolean(process.env["OPENROUTER_API_KEY"]);
  if (!credKeyB64 && !hasDevOpenrouter) {
    throw new Error(
      "BYOK: set CREDENTIAL_ENCRYPTION_KEY (production, per-tenant keys from connector_connections) or OPENROUTER_API_KEY (single-tenant dev)",
    );
  }

  // Pick the Shopify credential source:
  //   - If CREDENTIAL_ENCRYPTION_KEY is set, read tokens from
  //     `connector_connections` (production / managed-install path).
  //   - Otherwise fall back to SHOPIFY_TEST_* env vars (dev / single-tenant).
  // `requireShopify` only gates the env-fallback variant — when we're on
  // the connector-backed path we don't expect SHOPIFY_TEST_* to be set.
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
    TenantAgentOverridesServiceLive,
  );

  // LLM — depends on LLMCredentialResolver. In production each tenant
  // brings their own provider + key (resolver consults the same
  // ConnectorCredentialStoreLive that Shopify/Gmail OAuth writes to).
  // In single-tenant dev we adapt OPENROUTER_API_KEY to a resolver that
  // returns the same credential for every tenant.
  const llmResolver = credKeyB64
    ? LLMCredentialResolverLive.pipe(
        Layer.provide(ConnectorCredentialStoreLive(parseKey(credKeyB64))),
      )
    : LLMCredentialResolverFromLLMConfig.pipe(
        Layer.provide(LLMConfigFromEnv),
      );
  const llm = LLMServiceLive.pipe(Layer.provide(llmResolver));

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

  // Platform mail (approval-link emails to the operator). When
  // RESEND_API_KEY + RESEND_FROM_ADDRESS are set, use the live Resend
  // layer. Otherwise fall back to the in-memory Test layer so the worker
  // still boots — useful for local dev without a Resend account.
  const resendApiKey = process.env["RESEND_API_KEY"];
  const resendFrom = process.env["RESEND_FROM_ADDRESS"];
  const mail =
    resendApiKey && resendFrom
      ? PlatformMailServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(TenantRepositoryLive, ResendConfigFromEnv),
          ),
        )
      : PlatformMailServiceTest({});

  // Approval-link config. Required in production (signing key must be
  // stable so links survive restarts), but we fall back to a dev key
  // when unset so the worker boots in tests / local dev. The signing
  // key is shared with apps/api so it can verify the same tokens.
  const approvalBaseUrl =
    process.env["APPROVAL_BASE_URL"] ?? "http://localhost:4000";
  const approvalSigningKey =
    process.env["APPROVAL_SIGNING_KEY"] ?? "dev-only-approval-key";
  const approvalLinkLayer = Layer.succeed(ApprovalLinkConfig, {
    baseUrl: approvalBaseUrl,
    signingKey: approvalSigningKey,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });

  // Conversation connector. When Google OAuth env is set we use
  // `GmailConversationLive` over the DB-backed `ConnectorCredentialStore`
  // (the same store the OAuth callback writes to). Otherwise we fall back
  // to the in-memory Test layer so the worker still boots — useful for
  // single-tenant dev runs that only exercise non-Gmail surfaces.
  // Adding a second connector (Outlook, IMAP, …) means another branch
  // here; tools, runtime, and agents stay untouched.
  const googleClientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const googleClientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  const conversation =
    credKeyB64 && googleClientId && googleClientSecret
      ? GmailConversationLive({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
        }).pipe(
          Layer.provide(ConnectorCredentialStoreLive(parseKey(credKeyB64))),
        )
      : ConversationServiceTest({});

  // Permission policy with the conditional refund threshold layered on.
  // Live impl consults `TenantRepository` to read each tenant's
  // `refundPolicy` block. Default `PermissionServiceDefault` is the
  // pure-static fallback used in unit tests; production wants the Live
  // layer so the per-tenant threshold actually applies.
  const permissions = PermissionServiceLive.pipe(
    Layer.provide(TenantRepositoryLive),
  );

  // In-memory registries. AgentRegistryWith / ToolRegistryWith can fail
  // with AgentAlreadyRegistered / ToolAlreadyRegistered during Layer
  // build — that would be a programmer error (we control the input
  // list), so we promote it to a defect. The agent + tool lists come
  // from `ALL_AGENTS` / `ALL_TOOLS`: single source of truth, shared
  // with the dashboard's settings catalog. New agent? Add it to
  // `packages/agents/src/index.ts:ALL_AGENTS` exactly once.
  const registry = Layer.mergeAll(
    Layer.orDie(AgentRegistryWith(ALL_AGENTS)),
    Layer.orDie(ToolRegistryWith(ALL_TOOLS)),
    permissions,
  );

  // env = everything the AgentRuntime AND the tool bodies need, except
  // DbClient (which we feed in via provide below). We expose env to the
  // outer fiber because tool.execute yields its own deps (CaseRepository,
  // ShopifyService) at call time — they are NOT consumed by
  // AgentRuntimeDefault itself; they're consumed inside the tools.
  const env = Layer.mergeAll(
    repos,
    registry,
    llm,
    shopify,
    conversation,
    mail,
    approvalLinkLayer,
  );

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
