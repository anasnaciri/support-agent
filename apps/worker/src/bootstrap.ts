import { Layer } from "effect";
import {
  AgentRegistryWith,
  PermissionServiceDefault,
  ToolRegistryWith,
  type AnyTool,
} from "@support-agent/agent-core";
import {
  orderStatusAgent,
  refundReviewAgent,
  supportTriage,
} from "@support-agent/agents";
import {
  agentHandoff,
  caseUpdateContext,
  caseUpdateStatus,
  conversationAskCustomer,
  conversationFetchThread,
  conversationReply,
  shopifyGetCustomer,
  shopifyGetOrder,
} from "@support-agent/tools";
import {
  AgentRuntimeDefault,
  ApprovalLinkConfig,
  ConversationServiceTest,
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
  TenantRepositoryLive,
  TransactionRunnerLive,
} from "@support-agent/db";
import { parseKey } from "@support-agent/services";
import {
  GmailConversationLive,
  LLMConfigFromEnv,
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

  // In-memory registries + permission policy. AgentRegistryWith /
  // ToolRegistryWith can fail with AgentAlreadyRegistered /
  // ToolAlreadyRegistered during Layer build — that would be a programmer
  // error (we control the input list), so we promote it to a defect.
  const registry = Layer.mergeAll(
    Layer.orDie(
      AgentRegistryWith([supportTriage, orderStatusAgent, refundReviewAgent]),
    ),
    Layer.orDie(
      ToolRegistryWith([
        caseUpdateContext as AnyTool,
        caseUpdateStatus as AnyTool,
        shopifyGetOrder as AnyTool,
        shopifyGetCustomer as AnyTool,
        conversationFetchThread as AnyTool,
        conversationReply as AnyTool,
        conversationAskCustomer as AnyTool,
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
