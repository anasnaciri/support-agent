import { Cause, Effect } from "effect";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  lookup as dnsLookup,
  resolveMx as dnsResolveMx,
} from "node:dns/promises";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  applyApprovalDecision,
  CaseRepository,
  ConnectorCredentialStore,
  ConversationService,
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  decisionToEvent,
  defaultRefundPolicy,
  DEFAULT_RETENTION_DAYS,
  encrypt,
  KnowledgeBaseService,
  legalAcceptanceIsCurrent,
  parseThreadId,
  namespaceThreadId,
  ShopifyAppProvisioningStore,
  TenantAgentOverridesService,
  TenantRepository,
  TransactionRunner,
  UrlFetchService,
  verifyShopifyWebhookHmac,
  type LLMProvider,
  type LegalAcceptance,
  type RefundPolicyMode,
} from "@support-agent/services";
import {
  AgentId,
  CaseId,
  ConnectorNotFound,
  ConnectorStoreDbError,
  TenantId,
  UserId,
} from "@support-agent/agent-core";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";
import {
  activeShopifyShopDomain,
  agentOverrides,
  approvalDetail,
  approvalsList,
  assignMemberRole,
  auditList,
  caseContextForTenant,
  caseDetail,
  caseEvents,
  casesList,
  connectionsList,
  createInvitation,
  createRole,
  createTenantForOrg,
  createWorkspaceForOrg,
  DbClient,
  deleteRole,
  ensureActingOwnerInOpenMode,
  findTenantIdByWorkosOrg,
  findWorkspaceForOrg,
  getMemberAccess,
  knowledgeDocuments,
  listMembers,
  listPendingInvitations,
  listRoles,
  listWorkspacesByWorkosOrg,
  reconcileInvitation,
  removeMember,
  renameRole,
  renameWorkspaceForOrg,
  revokeInvitation,
  setRolePermissions,
  parsePageNumber,
  parsePageSize,
  resumeCase,
  takeOverCase,
  tenantByWorkosOrg,
  tenantDeletionSnapshot,
  todaySummary,
  usageRows,
  type DrizzleDb,
} from "@support-agent/db";
import {
  RBAC_PERMISSIONS,
  isRbacPermissionId,
  type RbacPermissionId,
} from "@support-agent/dashboard-contracts";
import { decideAuthz, sessionPermissions } from "./auth/dashboard-authz.js";
import { fetchModelCatalog } from "@support-agent/providers";
import {
  authenticateDashboardToken,
  isWorkspaceIdShape,
  parseAdminAuth,
} from "./auth/dashboard-auth.js";
import {
  makeRemoteWorkosVerifier,
  type DashboardTokenVerifier,
} from "./auth/dashboard-jwt.js";
import {
  makeWorkosUserDirectory,
  type WorkosUserDirectory,
} from "./auth/workos-directory.js";
import { retryCaseNow } from "./features/dashboard/case-retry.js";
import {
  TELEGRAM_LINK_TTL_MS,
  mintTelegramLinkToken,
} from "./telegram-link.js";
import {
  isTelegramWebhookAuthorized,
  processTelegramUpdate,
} from "./telegram-webhook.js";
import { buildCatalogResponse } from "./features/dashboard/catalog.js";
import {
  conversationUnavailableReason,
  projectConversationThread,
  resolveCaseConversationThread,
} from "./features/dashboard/conversation-thread.js";
import {
  buildModelsResponse,
  resolveActiveLlmCredential,
  resolveLlmCredentialStatus,
} from "./features/dashboard/llm.js";
import {
  resolveCustomerForContext,
  resolveOrderForContext,
  resolveShopCurrencyCode,
} from "./features/dashboard/shopify-panels.js";
import {
  buildInstallUrl,
  buildManagedInstallUrl,
  isValidShopDomain,
  normalizeShopDomain,
  signState,
  verifyCallbackHmac,
  verifyState,
} from "./features/shopify/install.js";
import { exchangeCodeForToken } from "./features/shopify/callback.js";
import {
  INSTALL_GRANT_TTL_MS,
  isInstallGrantProvider,
  signInstallGrant,
  verifyInstallGrant,
} from "./auth/install-grant.js";
import {
  resolveShopifyAppForShop,
  resolveShopifyAppForTenant,
  type GlobalShopifyApp,
} from "./features/shopify/app-resolver.js";
import {
  checkAdminShopifyAppPcd,
  getAdminShopifyApp,
  putAdminShopifyApp,
  revokeAdminShopifyApp,
} from "./admin-shopify-app.js";
import {
  getTenantDetailForAdmin,
  listTenantsForAdmin,
} from "./admin-tenants.js";
import {
  getAdminAccountDetail,
  putAdminAccountOpenRouter,
  putAdminWorkspaceOpenRouter,
  revokeAdminAccountOpenRouter,
  revokeAdminWorkspaceOpenRouter,
  type AdminOpenRouterMutationResult,
} from "./admin-openrouter.js";
import {
  dashboardConnectErrorRedirect,
  dashboardConnectRedirect,
} from "./features/connect/redirect.js";
import {
  activeMailboxConflict,
  alreadyConnectedRedirect,
  type OAuthMailboxProvider,
} from "./features/connect/guard.js";
import {
  assertShopifyShopConnectable,
  claimShopifyShopForTenant,
  findTenantByShop,
  ShopifyInstallTenantNotFound,
  ShopifyShopAlreadyConnected,
} from "./features/shopify/tenant-resolver.js";
import {
  parseCustomersDataRequest,
  parseCustomersRedact,
  parseShopRedact,
  parseUninstallPayload,
} from "./features/shopify/webhook.js";
import {
  recordDataRequest,
  redactCustomer,
  redactShop,
} from "./compliance-redaction.js";
import {
  buildConnectorGrants,
  makePgBossAccountCleanupPublisher,
  resolveCleanupTargets,
  type AccountCleanupJobData,
  type EncryptedConnectorGrant,
} from "./account-deletion.js";
import {
  makePgBossShopifyPolicyImportPublisher,
  type ShopifyPolicyImportJobData,
} from "./features/shopify/policy-import-queue.js";
import {
  buildGoogleAuthorizeUrl,
  isGoogleOAuthProvider,
  signGoogleInstallState,
  verifyGoogleInstallState,
  type GoogleOAuthProvider,
} from "./features/mailbox/google-install.js";
import {
  exchangeCodeForGoogleToken,
  fetchGoogleUserEmail,
} from "./features/mailbox/google-callback.js";
import {
  buildMicrosoftAuthorizeUrl,
  signMicrosoftInstallState,
  verifyMicrosoftInstallState,
} from "./features/mailbox/microsoft-install.js";
import {
  exchangeCodeForMicrosoftToken,
  fetchMicrosoftUserEmail,
} from "./features/mailbox/microsoft-callback.js";
import {
  handleGraphNotification,
  parseGraphNotifications,
  parseGraphValidationToken,
} from "./features/mailbox/graph-webhook.js";
import {
  appUninstalledWebhookUrl,
  registerAppUninstalledWebhook,
} from "./features/shopify/webhook-registration.js";
import {
  startGmailWatch,
  revokeConnectorGrant,
  graphCreateSubscription,
  GRAPH_SUBSCRIPTION_TTL_MS,
  makeImapSmtpOps,
  type ImapSmtpConfig,
  type ImapSmtpOps,
} from "@support-agent/providers";
import {
  parseImapConnectBody,
  imapConnectionMetadata,
} from "./features/mailbox/imap-connect.js";
import { discoverImapSettings, type DiscoveryIo } from "./features/mailbox/imap-discovery.js";
import {
  backfillUnreadGmailInbox,
  findTenantByGmailMailbox,
  handleGmailPushNotification,
  parseGmailPushEnvelope,
} from "./features/mailbox/gmail-webhook.js";
import {
  decideApproval,
  extractToken,
  makePgBossApprovalPublisher,
  matchApprovalRoute,
  renderApprovalConfirmPage,
  renderApprovalPage,
  verifyApprovalLink,
} from "./approval-endpoints.js";
import { PgBoss } from "pg-boss";
import {
  buildApiLayers,
  loadApiConfig,
  type ApiConfig,
  type ApiLayer,
} from "./bootstrap.js";
import { renderDataProcessingNoticeHtml } from "./legal.js";
import {
  approvalParamsSchema,
  errorResponseSchema,
  gmailParamsSchema,
  googleCallbackQuerySchema,
  googleCallbackSuccessSchema,
  googleInstallQuerySchema,
  installedQuerySchema,
  shopifyCallbackQuerySchema,
  shopifyCallbackSuccessSchema,
  shopifyInstallQuerySchema,
  TAGS,
  tokenQuerySchema,
  webhookAckSchema,
} from "./platform/schemas.js";

// ============================================================
// Extracted handler modules
// ============================================================
//
// server.ts is the composition root: it builds the app, wires every route to
// a handler below, and owns process lifecycle. The handler bodies live in the
// sibling modules imported here (shared request/response/auth/db helpers in
// ./http.js + ./dashboard-context.js, the lazy pg-boss singleton in ./pgboss.js).
import { sendJson, sendText, sendHtml, parseJsonBody } from "./platform/http.js";
export { strList } from "./platform/http.js";
import {
  enforceDashboardPermission,
  authenticateDashboardOrg,
} from "./auth/dashboard-context.js";
import { stopApprovalBoss } from "./platform/pgboss.js";
import {
  handleDashboardToday,
  handleDashboardCases,
  handleDashboardCaseDetail,
  handleDashboardCaseConversationThread,
  handleDashboardCaseEvents,
  handleDashboardApprovals,
  handleDashboardApprovalDetail,
  handleDashboardCaseShopify,
  handleDashboardUsage,
  handleDashboardAgentOverrides,
  handleDashboardConnections,
  handleDashboardShopifyApp,
  handleDashboardAudit,
  handleDashboardApprovalAction,
  handleDashboardTakeover,
  handleDashboardResume,
  handleDashboardRetry,
} from "./features/dashboard/case-handlers.js";
import {
  handleDashboardAccountDelete,
  handleAdminTenantDelete,
  handleAdminShopifyAppPut,
  handleAdminShopifyAppGet,
  handleAdminShopifyAppDelete,
  handleAdminShopifyAppPcdCheck,
  handleAdminTenantsList,
  handleAdminTenantDetail,
  handleAdminAccountDetail,
  handleAdminAccountOpenRouterPut,
  handleAdminAccountOpenRouterDelete,
  handleAdminWorkspaceOpenRouterPut,
  handleAdminWorkspaceOpenRouterDelete,
} from "./account-admin-handlers.js";
import {
  handleDashboardCatalog,
  handleDashboardModels,
  handleDashboardLlmStatus,
  handleDashboardTenant,
  handleDashboardWorkspaces,
  handleDashboardWorkspaceCreate,
  handleDashboardWorkspaceRename,
  handleDashboardWorkspaceDelete,
  handleDashboardShopCurrency,
  handleDashboardSettings,
  handleDashboardOnboarding,
  handleDashboardLegalAcceptance,
  handleDashboardAgentModelSet,
  handleDashboardAgentModelClear,
  handleDashboardAgentSystemPromptSet,
  handleDashboardAgentSystemPromptClear,
  handleDashboardAgentToolPermissionSet,
  handleDashboardAgentToolPermissionClear,
} from "./features/dashboard/settings-handlers.js";
import {
  handleDashboardKnowledgeList,
  handleDashboardKnowledgeGet,
  handleDashboardKnowledgeCreate,
  handleDashboardKnowledgeUpdate,
  handleDashboardKnowledgeDelete,
  handleDashboardKnowledgeResync,
} from "./features/dashboard/knowledge-handlers.js";
import {
  handleDashboardLlmConnect,
  handleDashboardLlmRevoke,
  handleDashboardRefundPolicy,
  handleDashboardSupplierSheet,
  handleDashboardSupplierSheetClear,
  handleDashboardConnect,
  handleDashboardConnectImap,
  handleDashboardImapDiscover,
  handleDashboardDisconnect,
  handleDashboardConnectTelegram,
} from "./features/dashboard/connect-handlers.js";
import {
  handleShopifyInstall,
  handleShopifyCallback,
  handleInstalledPage,
  handleAppUninstalled,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
} from "./features/shopify/handlers.js";
import {
  handleGoogleInstall,
  handleGoogleCallback,
  handleMicrosoftInstall,
  handleMicrosoftCallback,
  handleGmailWebhook,
  handleGraphWebhook,
} from "./features/mailbox/handlers.js";
import {
  handleApprovalConfirmPage,
  handleApprovalDecision,
} from "./approval-handlers.js";
import {
  handleDashboardMeSession,
  handleDashboardPermissionCatalog,
  handleDashboardMembers,
  handleDashboardRoles,
  handleDashboardMemberInvite,
  handleDashboardMemberRole,
  handleDashboardMemberRemove,
  handleDashboardInvitationRevoke,
  handleDashboardRoleCreate,
  handleDashboardRoleRename,
  handleDashboardRolePermissions,
  handleDashboardRoleDelete,
} from "./features/members/rbac-handlers.js";

// ============================================================
// Server
// ============================================================

export interface ServerHandle {
  readonly close: () => Promise<void>;
  readonly port: number;
}

/**
 * Strip secret-bearing query params from a URL before it reaches the
 * request log (audit S6). Several capability secrets travel in `?…`:
 * the Gmail push token, signed approval tokens, and install grants —
 * anyone with log access could previously harvest them.
 */
const SECRET_QUERY_PARAMS = ["token", "grant", "code", "id_token", "hmac"];

export const redactUrlSecrets = (url: string): string => {
  const q = url.indexOf("?");
  if (q === -1) return url;
  try {
    const params = new URLSearchParams(url.slice(q + 1));
    let touched = false;
    for (const name of SECRET_QUERY_PARAMS) {
      if (params.has(name)) {
        params.set(name, "[redacted]");
        touched = true;
      }
    }
    if (!touched) return url;
    return `${url.slice(0, q)}?${params.toString()}`;
  } catch {
    // Unparseable query string — drop it entirely rather than log it.
    return url.slice(0, q);
  }
};

/**
 * Pino logger config. Enabled by default (structured JSON); quieted to
 * `warn` under tests so the DB-gated integration suite isn't drowned in
 * per-request lines. `LOG_LEVEL` overrides the level outside tests.
 * The request serializer redacts secret query params (audit S6) and the
 * `redact` paths cover headers that may carry bearer tokens.
 */
const loggerConfig = () => ({
  level:
    process.env["NODE_ENV"] === "test"
      ? "warn"
      : (process.env["LOG_LEVEL"] ?? "info"),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-goog-channel-token']",
    ],
    censor: "[redacted]",
  },
  serializers: {
    req: (req: { method: string; url: string }) => ({
      method: req.method,
      url: redactUrlSecrets(req.url ?? ""),
    }),
  },
});

export interface StartServerOptions {
  /**
   * Override the WorkOS access-token verifier. Production leaves this unset and
   * a JWKS-backed verifier is built from `cfg.workos`; integration tests inject
   * a static verifier so they can drive the resolved org/user without minting
   * real RS256 JWTs.
   */
  readonly dashboardTokenVerifier?: DashboardTokenVerifier;
  /**
   * Override the WorkOS user directory (verified-email lookup). Production
   * builds it from `cfg.workos.apiKey`; tests inject a static map so invite
   * reconcile can resolve a member's verified email without a WorkOS call.
   */
  readonly workosUserDirectory?: WorkosUserDirectory;
}

export const startServer = async (
  cfg: ApiConfig,
  opts: StartServerOptions = {},
): Promise<ServerHandle> => {
  const layer = buildApiLayers(cfg);

  // S14: the dashboard forwards the merchant's WorkOS access token; the api
  // verifies it against WorkOS's client-scoped JWKS. Built once at boot
  // (createRemoteJWKSet is lazy) and read off `req.server` by the auth seam.
  // `null` when WorkOS isn't configured → `/dashboard/*` responds 503.
  const dashboardTokenVerifier: DashboardTokenVerifier | null =
    opts.dashboardTokenVerifier ??
    (cfg.workos
      ? makeRemoteWorkosVerifier(
          cfg.workos.jwksUrl,
          cfg.workos.issuer ? { issuer: cfg.workos.issuer } : {},
        )
      : null);

  // Verified-email lookup for invite reconcile (closes the x-user-email spoof).
  // `null` when WORKOS_API_KEY is unset → reconcile is a no-op, never falls back
  // to the header.
  const workosUserDirectory: WorkosUserDirectory | null =
    opts.workosUserDirectory ??
    (cfg.workos?.apiKey
      ? makeWorkosUserDirectory(cfg.workos.apiKey)
      : null);

  const app: FastifyInstance = Fastify({
    logger: loggerConfig(),
    // Matches the old readRawBody cap. Shopify/Pub/Sub payloads are tiny;
    // anything near the cap is suspect and fails closed with 413.
    bodyLimit: 1024 * 1024,
  });
  app.decorate("dashboardTokenVerifier", dashboardTokenVerifier);
  app.decorate("workosUserDirectory", workosUserDirectory);

  // Webhook HMAC is computed over the exact bytes the provider sent, so we
  // keep the raw body as a Buffer instead of letting Fastify JSON-parse it
  // (which would change whitespace/key order and break the signature).
  // Handlers JSON-parse afterwards. We drop the built-in parsers first —
  // otherwise Fastify's `application/json` parser (more specific than `*`)
  // would still hand handlers a parsed object for Shopify + Pub/Sub
  // payloads. With them gone, the catch-all buffers every content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Security headers (audit S11). The CSP is strict because the only HTML
  // this server emits is self-contained receipt/landing pages with inline
  // styles — no scripts, no external assets. CORS stays closed on purpose:
  // the dashboard talks to this api server-to-server with a bearer token,
  // never from the browser with cookies.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Rate limiting (audit S11). One generous global bucket — the goal is
  // blunting token brute-force and webhook floods, not traffic shaping.
  // Keyed by IP; the worker/dashboard talk to Postgres or use one bearer
  // token from a handful of IPs, so legitimate traffic never approaches
  // this. Disabled under tests to keep suites deterministic.
  if (process.env["NODE_ENV"] !== "test") {
    await app.register(fastifyRateLimit, {
      max: Number(process.env["RATE_LIMIT_MAX"] ?? 600),
      timeWindow: "1 minute",
    });
  }

  // OpenAPI generation. Registered before the routes so its onRoute hook
  // captures every schema below; the browsable UI lands at /docs.
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "support-agent API",
        description:
          "Webhook, OAuth install/callback, and approval-link edge for the support-agent runtime.",
        version: "0.0.0",
      },
      tags: TAGS,
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  const errorResponses = {
    "4xx": errorResponseSchema,
    "5xx": errorResponseSchema,
  };

  // ---- Shopify install + callback ----
  app.get(
    "/shopify/install",
    {
      schema: {
        tags: ["shopify"],
        summary: "Start the Shopify OAuth install flow",
        querystring: shopifyInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleShopifyInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/shopify/auth/callback",
    {
      schema: {
        tags: ["shopify"],
        summary: "Shopify OAuth authorization-code callback",
        querystring: shopifyCallbackQuerySchema,
        response: { 200: shopifyCallbackSuccessSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleShopifyCallback(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/installed",
    {
      schema: {
        tags: ["shopify"],
        summary: "Merchant landing page after a successful install",
        querystring: installedQuerySchema,
      },
    },
    async (req, res) => {
      handleInstalledPage(req, res);
      return res;
    },
  );

  // ---- Shopify lifecycle + compliance webhooks ----
  app.post(
    "/webhooks/shopify/app/uninstalled",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify app/uninstalled — revoke the connector",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleAppUninstalled(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/customers/data_request",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR customers/data_request",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleCustomersDataRequest(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/customers/redact",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR customers/redact",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleCustomersRedact(cfg, layer, req, res);
      return res;
    },
  );

  app.post(
    "/webhooks/shopify/shop/redact",
    {
      schema: {
        tags: ["webhooks", "shopify"],
        summary: "Shopify GDPR shop/redact",
        response: { 200: webhookAckSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleShopRedact(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Google / Gmail OAuth ----
  app.get(
    "/google/install",
    {
      schema: {
        tags: ["google"],
        summary: "Start the Google / Gmail OAuth install flow",
        querystring: googleInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleGoogleInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/google/auth/callback",
    {
      schema: {
        tags: ["google"],
        summary: "Google OAuth authorization-code callback",
        querystring: googleCallbackQuerySchema,
        response: { 200: googleCallbackSuccessSchema, ...errorResponses },
      },
    },
    async (req, res) => {
      await handleGoogleCallback(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Microsoft / Outlook OAuth ----
  app.get(
    "/microsoft/install",
    {
      schema: {
        tags: ["microsoft"],
        summary: "Start the Microsoft / Outlook OAuth install flow",
        querystring: googleInstallQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleMicrosoftInstall(cfg, layer, req, res);
      return res;
    },
  );

  app.get(
    "/microsoft/auth/callback",
    {
      schema: {
        tags: ["microsoft"],
        summary: "Microsoft OAuth authorization-code callback",
        querystring: googleCallbackQuerySchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleMicrosoftCallback(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Gmail Pub/Sub push webhook (tenant-less + legacy tenant path) ----
  const gmailWebhookOpts = {
    schema: {
      tags: ["webhooks", "google"],
      summary: "Gmail Pub/Sub push notification",
      querystring: tokenQuerySchema,
      response: { 200: webhookAckSchema, ...errorResponses },
    },
  };
  app.post("/webhooks/conversations/gmail", gmailWebhookOpts, async (req, res) => {
    await handleGmailWebhook(cfg, layer, req, res);
    return res;
  });
  app.post(
    "/webhooks/conversations/gmail/:tenantId",
    {
      schema: {
        ...gmailWebhookOpts.schema,
        params: gmailParamsSchema,
      },
    },
    async (req, res) => {
      await handleGmailWebhook(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Microsoft Graph change-notification webhook ----
  app.post(
    "/webhooks/conversations/outlook/:tenantId",
    {
      schema: {
        tags: ["webhooks", "microsoft"],
        summary: "Microsoft Graph mailbox change notification",
        params: gmailParamsSchema,
        response: errorResponses,
      },
    },
    async (req, res) => {
      await handleGraphWebhook(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Telegram bot webhook (merchant notification channel linking) ----
  app.post(
    "/webhooks/notifications/telegram",
    {
      schema: {
        tags: ["webhooks", "telegram"],
        summary: "Telegram bot update (chat linking via /start)",
        response: errorResponses,
      },
    },
    async (req, res) => {
      if (!cfg.telegram) {
        return sendJson(res, 503, { error: "telegram_not_configured" });
      }
      const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
      if (
        !isTelegramWebhookAuthorized(
          typeof secretHeader === "string" ? secretHeader : undefined,
          cfg.telegram.webhookSecret,
        )
      ) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const outcome = await Effect.runPromise(
        Effect.provide(
          processTelegramUpdate(parseJsonBody(req), {
            signingKey: cfg.stateSigningKey,
            botToken: cfg.telegram.botToken,
          }),
          layer,
        ),
      );
      // Always 2xx after auth — Telegram retries non-2xx and a retry
      // can't fix an invalid token or an ignorable update.
      return sendJson(res, 200, { ok: true, outcome });
    },
  );

  // ---- Approval links ----
  // GET verifies the signed link and renders a confirmation page; only
  // the POST (submitted by the page's form) decides. Email-security
  // scanners follow GETs — they must not be able to decide (audit S2).
  app.get(
    "/approvals/:approvalId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary:
          "Confirmation page for an emailed approval link (no state change)",
        params: approvalParamsSchema,
        querystring: tokenQuerySchema,
      },
    },
    async (req, res) => {
      handleApprovalConfirmPage(cfg, req, res);
      return res;
    },
  );
  app.post(
    "/approvals/:approvalId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary: "Approve or reject a gated tool call (confirm-page POST)",
        params: approvalParamsSchema,
      },
    },
    async (req, res) => {
      await handleApprovalDecision(cfg, layer, req, res);
      return res;
    },
  );

  // ---- Dashboard read API ----
  const dashboardJsonResponse = {
    200: { type: "object", additionalProperties: true },
    ...errorResponses,
  };
  const dashboardGet = (
    path: string,
    summary: string,
    handler: (
      cfg: ApiConfig,
      layer: ApiLayer,
      req: FastifyRequest,
      res: FastifyReply,
    ) => Promise<FastifyReply>,
    // When set, the request is RBAC-gated: the acting member must hold this
    // permission. Omit for pre-tenant / self-service reads any member may make.
    permission?: RbacPermissionId,
  ): void => {
    app.get(
      path,
      {
        schema: {
          tags: ["dashboard"],
          summary,
          response: dashboardJsonResponse,
        },
      },
      async (req, res) => {
        if (
          permission &&
          !(await enforceDashboardPermission(cfg, layer, req, res, permission))
        ) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  dashboardGet(
    "/dashboard/today",
    "Today-view rollup",
    handleDashboardToday,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases",
    "Paginated cases list",
    handleDashboardCases,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id",
    "Case detail with timeline + approvals",
    handleDashboardCaseDetail,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/conversation-thread",
    "Live customer email thread for a case",
    handleDashboardCaseConversationThread,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/events",
    "New audit events for a case since ?since=",
    handleDashboardCaseEvents,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/shopify",
    "Case-detail Shopify customer/order panels",
    handleDashboardCaseShopify,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/approvals",
    "Paginated approvals list with facets",
    handleDashboardApprovals,
    "approvals.view",
  );
  dashboardGet(
    "/dashboard/approvals/:id",
    "Approval detail",
    handleDashboardApprovalDetail,
    "approvals.view",
  );
  dashboardGet(
    "/dashboard/audit",
    "Cross-case audit log",
    handleDashboardAudit,
    "audit.view",
  );
  dashboardGet(
    "/dashboard/shopify-app",
    "Shopify connect gate (pilot provisioning status)",
    handleDashboardShopifyApp,
    "settings.integrations",
  );
  dashboardGet(
    "/dashboard/connections",
    "Connector connections (integrations)",
    handleDashboardConnections,
    "settings.integrations",
  );
  dashboardGet(
    "/dashboard/usage",
    "LLM usage rows in a time window",
    handleDashboardUsage,
    "audit.view",
  );
  dashboardGet(
    "/dashboard/agent-overrides",
    "Per-agent model overrides",
    handleDashboardAgentOverrides,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/knowledge",
    "Knowledge-base document summaries",
    handleDashboardKnowledgeList,
    "knowledge.view",
  );
  dashboardGet(
    "/dashboard/knowledge/:id",
    "One knowledge document (full content)",
    handleDashboardKnowledgeGet,
    "knowledge.view",
  );
  dashboardGet(
    "/dashboard/catalog",
    "Agent + tool inventory",
    handleDashboardCatalog,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/models",
    "Tenant LLM model catalog",
    handleDashboardModels,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/llm",
    "Effective workspace/account LLM credential status",
    handleDashboardLlmStatus,
    "settings.llm",
  );
  // Pre-tenant / org-scoped reads — reachable by any signed-in org member (no
  // per-workspace RBAC; they're how the dashboard bootstraps its context).
  dashboardGet(
    "/dashboard/tenant",
    "The org's tenant (or null → onboarding)",
    handleDashboardTenant,
  );
  dashboardGet(
    "/dashboard/workspaces",
    "The org's workspaces, default first",
    handleDashboardWorkspaces,
  );
  // Low-sensitivity resolved settings (refund numbers, currency) consumed by
  // shared UI; the admin pages that EDIT them are redirect-gated and the write
  // endpoints below are permission-gated.
  dashboardGet(
    "/dashboard/settings",
    "Resolved tenant settings (refund policy + supplier sheet)",
    handleDashboardSettings,
  );
  dashboardGet(
    "/dashboard/shop-currency",
    "Best-effort Shopify store currency (ISO 4217) or null",
    handleDashboardShopCurrency,
  );

  // Mutations. No response serializer (default JSON.stringify) so the
  // discriminated result/Date fields pass through untouched.
  const dashboardPost = (
    path: string,
    summary: string,
    handler: (
      cfg: ApiConfig,
      layer: ApiLayer,
      req: FastifyRequest,
      res: FastifyReply,
    ) => Promise<FastifyReply>,
    permission?: RbacPermissionId,
  ): void => {
    app.post(
      path,
      { schema: { tags: ["dashboard"], summary } },
      async (req, res) => {
        if (
          permission &&
          !(await enforceDashboardPermission(cfg, layer, req, res, permission))
        ) {
          return res;
        }
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  dashboardPost(
    "/dashboard/approvals/:id/approve",
    "Approve an approval (manager)",
    handleDashboardApprovalAction("approve"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/approvals/:id/reject",
    "Reject an approval (manager)",
    handleDashboardApprovalAction("reject"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/cases/:id/takeover",
    "Take over a case (manager)",
    handleDashboardTakeover,
    "cases.takeover",
  );
  dashboardPost(
    "/dashboard/cases/:id/resume",
    "Hand a taken-over case back to the agent (manager)",
    handleDashboardResume,
    "cases.resume",
  );
  dashboardPost(
    "/dashboard/cases/:id/retry",
    "Hand a taken-over case back and have the agent retry now (manager)",
    handleDashboardRetry,
    "cases.retry",
  );
  // Org-scoped (no resolved workspace) — these use authenticateDashboardOrg and
  // remain reachable by any org member; workspace/account management is an
  // org-level concern, hidden cosmetically from non-admins in the dashboard.
  dashboardPost(
    "/dashboard/onboarding",
    "Create a tenant for the org",
    handleDashboardOnboarding,
  );
  dashboardPost(
    "/dashboard/workspaces",
    "Create an additional workspace under the org",
    handleDashboardWorkspaceCreate,
  );
  dashboardPost(
    "/dashboard/workspaces/:id/rename",
    "Rename a workspace",
    handleDashboardWorkspaceRename,
  );
  dashboardPost(
    "/dashboard/workspaces/:id/delete",
    "Delete one workspace (org + siblings survive)",
    handleDashboardWorkspaceDelete,
  );
  dashboardPost(
    "/dashboard/legal-acceptance",
    "Accept the current data processing notice + DPA",
    handleDashboardLegalAcceptance,
    "account.manage",
  );
  dashboardPost(
    "/dashboard/agents/:id/model",
    "Set a per-agent model override",
    handleDashboardAgentModelSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/model/clear",
    "Clear a per-agent model override",
    handleDashboardAgentModelClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/system-prompt",
    "Set a per-agent system prompt (appended to the built-in prompt)",
    handleDashboardAgentSystemPromptSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/system-prompt/clear",
    "Clear a per-agent system prompt",
    handleDashboardAgentSystemPromptClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/tool-permission",
    "Set a per-agent tool permission (ask first vs auto)",
    handleDashboardAgentToolPermissionSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/tool-permission/clear",
    "Clear a per-agent tool permission override",
    handleDashboardAgentToolPermissionClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/knowledge",
    "Create a knowledge document (paste or fetch a URL)",
    handleDashboardKnowledgeCreate,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id",
    "Update a knowledge document (title / text content)",
    handleDashboardKnowledgeUpdate,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id/delete",
    "Delete a knowledge document",
    handleDashboardKnowledgeDelete,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id/resync",
    "Re-fetch a URL document's snapshot",
    handleDashboardKnowledgeResync,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/llm",
    "Connect a BYOK LLM credential",
    handleDashboardLlmConnect,
    "settings.llm",
  );
  dashboardPost(
    "/dashboard/llm/revoke",
    "Revoke the tenant's LLM credential",
    handleDashboardLlmRevoke,
    "settings.llm",
  );
  dashboardPost(
    "/dashboard/refund-policy",
    "Set the conditional refund policy",
    handleDashboardRefundPolicy,
    "settings.refund_policy",
  );
  dashboardPost(
    "/dashboard/supplier-sheet",
    "Set the supplier-escalation sheet",
    handleDashboardSupplierSheet,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/supplier-sheet/clear",
    "Clear the supplier-escalation sheet",
    handleDashboardSupplierSheetClear,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connect/:provider",
    "Mint a signed install grant + return the provider install URL",
    handleDashboardConnect,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/imap",
    "Connect a generic IMAP/SMTP mailbox (credentials, no OAuth)",
    handleDashboardConnectImap,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/imap/discover",
    "Autodiscover IMAP/SMTP settings for a mailbox address",
    handleDashboardImapDiscover,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/telegram",
    "Mint a Telegram notification-channel linking deep link",
    handleDashboardConnectTelegram,
    "settings.notifications",
  );
  dashboardPost(
    "/dashboard/connections/:provider/disconnect",
    "Disconnect (revoke) a connector",
    handleDashboardDisconnect,
    "settings.integrations",
  );
  // Org-scoped (authenticateDashboardOrg) — deletes the whole account.
  dashboardPost(
    "/dashboard/account/delete",
    "Delete the tenant's own account (irreversible)",
    handleDashboardAccountDelete,
  );

  // ---- Member RBAC ----
  // /me/session is reachable by any member (it's how the dashboard loads its
  // own access); everything else requires members.manage.
  dashboardPost(
    "/dashboard/me/session",
    "Reconcile invites + return the acting member's access",
    handleDashboardMeSession,
  );
  dashboardGet(
    "/dashboard/permission-catalog",
    "Static RBAC permission catalog",
    handleDashboardPermissionCatalog,
    "members.manage",
  );
  dashboardGet(
    "/dashboard/members",
    "Workspace members + pending invitations",
    handleDashboardMembers,
    "members.manage",
  );
  dashboardGet(
    "/dashboard/roles",
    "Workspace roles + grants",
    handleDashboardRoles,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/invite",
    "Invite a member (persist a pending invitation)",
    handleDashboardMemberInvite,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/:uuid/role",
    "Change a member's role",
    handleDashboardMemberRole,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/members/:uuid/remove",
    "Remove a member",
    handleDashboardMemberRemove,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/invitations/:id/revoke",
    "Revoke a pending invitation",
    handleDashboardInvitationRevoke,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles",
    "Create a role",
    handleDashboardRoleCreate,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/rename",
    "Rename a role",
    handleDashboardRoleRename,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/permissions",
    "Replace a role's permission grants",
    handleDashboardRolePermissions,
    "members.manage",
  );
  dashboardPost(
    "/dashboard/roles/:id/delete",
    "Delete a role",
    handleDashboardRoleDelete,
    "members.manage",
  );

  // ---- Admin (platform operator) ----
  app.post(
    "/admin/tenants/:id/delete",
    {
      schema: {
        tags: ["admin"],
        summary: "Delete any tenant's account (platform operator)",
      },
    },
    async (req, res) => {
      await handleAdminTenantDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants",
    {
      schema: {
        tags: ["admin"],
        summary: "List all tenants (platform operator)",
      },
    },
    async (req, res) => {
      await handleAdminTenantsList(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Tenant detail: Shopify app + connector health (operator)",
      },
    },
    async (req, res) => {
      await handleAdminTenantDetail(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/accounts/:organizationId",
    {
      schema: {
        tags: ["admin"],
        summary: "Account workspaces + inherited OpenRouter status (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountDetail(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/accounts/:organizationId/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Set the inherited account OpenRouter key (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountOpenRouterPut(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/accounts/:organizationId/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke the inherited account OpenRouter key (operator)",
      },
    },
    async (req, res) => {
      await handleAdminAccountOpenRouterDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/tenants/:id/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Set a workspace OpenRouter override (operator)",
      },
    },
    async (req, res) => {
      await handleAdminWorkspaceOpenRouterPut(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/tenants/:id/openrouter",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a workspace LLM override (operator)",
      },
    },
    async (req, res) => {
      await handleAdminWorkspaceOpenRouterDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.put(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Provision a tenant's Shopify custom app (client_id + secret)",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppPut(cfg, layer, req, res);
      return res;
    },
  );
  app.get(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Read a tenant's Shopify app provisioning (never the secret)",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppGet(cfg, layer, req, res);
      return res;
    },
  );
  app.delete(
    "/admin/tenants/:id/shopify-app",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a tenant's Shopify app provisioning",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppDelete(cfg, layer, req, res);
      return res;
    },
  );
  app.post(
    "/admin/tenants/:id/shopify-app/pcd-check",
    {
      schema: {
        tags: ["admin"],
        summary:
          "Probe whether the connected store returns protected customer data",
      },
    },
    async (req, res) => {
      await handleAdminShopifyAppPcdCheck(cfg, layer, req, res);
      return res;
    },
  );

  // ---- System ----
  app.get(
    "/legal/data-processing",
    {
      schema: {
        tags: ["system"],
        summary: "Public data processing notice and DPA",
      },
    },
    async (_req, res) => sendHtml(res, 200, renderDataProcessingNoticeHtml()),
  );

  app.get(
    "/healthz",
    { schema: { tags: ["system"], summary: "Liveness probe" } },
    async (_req, res) => sendText(res, 200, "ok"),
  );

  app.get(
    "/openapi.json",
    { schema: { tags: ["system"], summary: "OpenAPI document", hide: true } },
    async () => app.swagger(),
  );

  app.setNotFoundHandler((_req, res) => sendJson(res, 404, { error: "not_found" }));

  app.setErrorHandler((err: FastifyError, req, res) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode === 413) {
      return sendJson(res, 413, {
        error: "body_too_large_or_unreadable",
        detail: err.message,
      });
    }
    if (err.validation) {
      return sendJson(res, 400, {
        error: "validation_failed",
        detail: err.message,
      });
    }
    req.log.error({ err }, "[api] unhandled error");
    return sendJson(res, 500, { error: "internal" });
  });

  await app.listen({ port: cfg.port, host: process.env["API_HOST"] ?? "0.0.0.0" });
  const address = app.server.address();
  const port =
    address && typeof address === "object" ? address.port : cfg.port;
  app.log.info(`[api] listening on http://localhost:${port}`);
  return {
    port,
    close: async () => {
      await app.close();
      // Stop the shared approval pg-boss (started lazily on the first
      // approval decision) so shutdown / tests don't leak its connection, and
      // drop the memoized publishers so a fresh server re-ensures the queue.
      await stopApprovalBoss();
    },
  };
};

// ============================================================
// Entrypoint
// ============================================================

const main = async () => {
  const cfg = loadApiConfig();
  const handle = await startServer(cfg);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

// Only run the entrypoint when invoked directly (e.g. `tsx src/server.ts`),
// not when imported by tests.
const invokedDirectly = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[api] failed to start:", err);
    process.exit(1);
  });
}
