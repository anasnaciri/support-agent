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
import { decideAuthz, sessionPermissions } from "./dashboard-authz.js";
import { fetchModelCatalog } from "@support-agent/providers";
import {
  authenticateDashboardToken,
  isWorkspaceIdShape,
  parseAdminAuth,
} from "./dashboard-auth.js";
import {
  makeRemoteWorkosVerifier,
  type DashboardTokenVerifier,
} from "./dashboard-jwt.js";
import {
  makeWorkosUserDirectory,
  type WorkosUserDirectory,
} from "./workos-directory.js";
import { retryCaseNow } from "./case-retry.js";
import {
  TELEGRAM_LINK_TTL_MS,
  mintTelegramLinkToken,
} from "./telegram-link.js";
import {
  isTelegramWebhookAuthorized,
  processTelegramUpdate,
} from "./telegram-webhook.js";
import { buildCatalogResponse } from "./dashboard-catalog.js";
import {
  conversationUnavailableReason,
  projectConversationThread,
  resolveCaseConversationThread,
} from "./dashboard-conversation-thread.js";
import {
  buildModelsResponse,
  resolveActiveLlmCredential,
  resolveLlmCredentialStatus,
} from "./dashboard-llm.js";
import {
  resolveCustomerForContext,
  resolveOrderForContext,
  resolveShopCurrencyCode,
} from "./dashboard-shopify.js";
import {
  buildInstallUrl,
  buildManagedInstallUrl,
  isValidShopDomain,
  normalizeShopDomain,
  signState,
  verifyCallbackHmac,
  verifyState,
} from "./shopify-install.js";
import { exchangeCodeForToken } from "./shopify-callback.js";
import {
  INSTALL_GRANT_TTL_MS,
  isInstallGrantProvider,
  signInstallGrant,
  verifyInstallGrant,
} from "./install-grant.js";
import {
  resolveShopifyAppForShop,
  resolveShopifyAppForTenant,
  type GlobalShopifyApp,
} from "./shopify-app-resolver.js";
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
} from "./post-connect-redirect.js";
import {
  activeMailboxConflict,
  alreadyConnectedRedirect,
  type OAuthMailboxProvider,
} from "./connect-guard.js";
import {
  assertShopifyShopConnectable,
  claimShopifyShopForTenant,
  findTenantByShop,
  ShopifyInstallTenantNotFound,
  ShopifyShopAlreadyConnected,
} from "./tenant-resolver.js";
import {
  parseCustomersDataRequest,
  parseCustomersRedact,
  parseShopRedact,
  parseUninstallPayload,
} from "./shopify-webhook.js";
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
} from "./shopify-policy-import-queue.js";
import {
  buildGoogleAuthorizeUrl,
  isGoogleOAuthProvider,
  signGoogleInstallState,
  verifyGoogleInstallState,
  type GoogleOAuthProvider,
} from "./google-install.js";
import {
  exchangeCodeForGoogleToken,
  fetchGoogleUserEmail,
} from "./google-callback.js";
import {
  buildMicrosoftAuthorizeUrl,
  signMicrosoftInstallState,
  verifyMicrosoftInstallState,
} from "./microsoft-install.js";
import {
  exchangeCodeForMicrosoftToken,
  fetchMicrosoftUserEmail,
} from "./microsoft-callback.js";
import {
  handleGraphNotification,
  parseGraphNotifications,
  parseGraphValidationToken,
} from "./graph-webhook.js";
import {
  appUninstalledWebhookUrl,
  registerAppUninstalledWebhook,
} from "./shopify-webhook-registration.js";
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
} from "./imap-connect.js";
import { discoverImapSettings, type DiscoveryIo } from "./imap-discovery.js";
import {
  backfillUnreadGmailInbox,
  findTenantByGmailMailbox,
  handleGmailPushNotification,
  parseGmailPushEnvelope,
} from "./gmail-webhook.js";
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
} from "./schemas.js";

// ============================================================
// Response helpers
// ============================================================
//
// Thin wrappers over the Fastify reply API. Each returns the reply so a
// route handler / lifecycle hook can `return sendX(...)` to signal the
// response is handled.

const sendJson = (
  res: FastifyReply,
  status: number,
  body: unknown,
): FastifyReply => res.code(status).send(body);

/**
 * Log an internal failure cause server-side and return an opaque
 * correlation id for the response body (audit S12). Effect `Cause`
 * stringification can surface stack traces, SQL fragments, and table
 * names — none of which belong in an HTTP response. Ops greps the
 * error id to find the full cause in the logs.
 */
const opaqueCause = (cause: unknown): string => {
  const errorId = randomUUID().slice(0, 8);
  // eslint-disable-next-line no-console
  console.error(`[api][error_id=${errorId}]`, cause);
  return `error_id=${errorId}`;
};

const sendRedirect = (res: FastifyReply, target: string): FastifyReply =>
  res.code(302).header("location", target).send();

const sendRedirectWithHeaders = (
  res: FastifyReply,
  target: string,
  headers: Record<string, string | ReadonlyArray<string>>,
): FastifyReply => {
  for (const [key, value] of Object.entries(headers)) res.header(key, value);
  return res.code(302).header("location", target).send();
};

const sendText = (
  res: FastifyReply,
  status: number,
  body: string,
): FastifyReply =>
  res.code(status).type("text/plain; charset=utf-8").send(body);

const sendHtml = (
  res: FastifyReply,
  status: number,
  body: string,
): FastifyReply =>
  res.code(status).type("text/html; charset=utf-8").send(body);

// ============================================================
// Dashboard read API (Path B)
// ============================================================

/** Run a Promise-returning DB query against the api layer's DbClient. */
const runWithDb = <T>(
  layer: ApiLayer,
  f: (db: DrizzleDb) => Promise<T>,
): Promise<T> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        return yield* Effect.promise(() => f(db));
      }),
      layer,
    ),
  );

type DashboardAuthResult =
  | {
      readonly ok: true;
      readonly tenantId: string;
      readonly userId: string | undefined;
      /** Verified WorkOS user id (`sub`) — for the verified-email lookup. */
      readonly workosUserId: string | undefined;
      readonly userEmail: string | undefined;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

// Per-request memo so the centralized RBAC guard (in dashboardGet/dashboardPost)
// and the handler's own authenticateDashboard call share ONE workspace
// resolution instead of querying twice.
const kDashAuth = Symbol("dashboardAuth");

/**
 * Shared auth for `/dashboard/*`: verify the service token, read the asserted
 * WorkOS org, resolve it to a WORKSPACE (tenant row). `x-workspace-id` pins
 * the request to one of the org's workspaces; without it the org's default
 * (oldest) workspace is used. 503 unconfigured, 401/400 bad auth, 400 on a
 * malformed workspace id, 404 when the org doesn't own the named workspace
 * (NOT 403 — the dashboard treats 403 as "needs onboarding", and a stale
 * workspace cookie must never bounce a real tenant there), 403 when the org
 * has no workspaces at all.
 */
/**
 * The WorkOS access-token verifier is built once at boot and decorated onto the
 * Fastify instance (see startServer); every `/dashboard/*` request reads it
 * from `req.server`. `null` → WorkOS isn't configured, so the dashboard API is
 * not available (503).
 */
const getDashboardVerifier = (
  req: FastifyRequest,
): DashboardTokenVerifier | null =>
  (req.server as unknown as {
    dashboardTokenVerifier: DashboardTokenVerifier | null;
  }).dashboardTokenVerifier;

/**
 * The WorkOS user directory (verified-email lookup), decorated alongside the
 * verifier. `null` → no `WORKOS_API_KEY`, so invite reconcile degrades to a
 * no-op rather than ever trusting the `x-user-email` header.
 */
const getWorkosDirectory = (
  req: FastifyRequest,
): WorkosUserDirectory | null =>
  (req.server as unknown as {
    workosUserDirectory: WorkosUserDirectory | null;
  }).workosUserDirectory;

const resolveDashboardAuth = async (
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardToken(
    req.headers as Record<string, string | undefined>,
    verifier,
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  if (parsed.workspaceId !== undefined) {
    if (!isWorkspaceIdShape(parsed.workspaceId)) {
      return { ok: false, status: 400, error: "invalid_workspace_id" };
    }
    const workspace = await runWithDb(layer, (db) =>
      findWorkspaceForOrg(db, parsed.organizationId, parsed.workspaceId!),
    );
    if (!workspace) {
      return { ok: false, status: 404, error: "workspace_not_found" };
    }
    return {
      ok: true,
      tenantId: workspace.id,
      userId: parsed.userId,
      workosUserId: parsed.workosUserId,
      userEmail: parsed.userEmail,
    };
  }
  const tenantId = await runWithDb(layer, (db) =>
    findTenantIdByWorkosOrg(db, parsed.organizationId),
  );
  if (!tenantId) {
    return { ok: false, status: 403, error: "no_tenant_for_organization" };
  }
  return {
    ok: true,
    tenantId,
    userId: parsed.userId,
    workosUserId: parsed.workosUserId,
    userEmail: parsed.userEmail,
  };
};

const authenticateDashboard = async (
  _cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  const store = req as unknown as Record<symbol, DashboardAuthResult | undefined>;
  const cached = store[kDashAuth];
  if (cached) return cached;
  const result = await resolveDashboardAuth(layer, req);
  store[kDashAuth] = result;
  return result;
};

/**
 * Centralized human-member RBAC gate. Authenticates, then checks the acting
 * member holds `permission` for the resolved workspace. Returns true when the
 * handler should proceed; otherwise it has already sent the error response
 * (401/403/404/503). Used by dashboardGet/dashboardPost for routes that
 * declare a required permission.
 */
const enforceDashboardPermission = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  permission: RbacPermissionId,
): Promise<boolean> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.error });
    return false;
  }
  // userId may be absent on legacy reads — decideAuthz allows those only while
  // the workspace is in open mode, and 401s once roles are configured.
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  const decision = decideAuthz(access, auth.userId, permission);
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return false;
  }
  return true;
};

type DashboardOrgAuthResult =
  | {
      readonly ok: true;
      readonly organizationId: string;
      readonly userId: string | undefined;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Auth for the pre-tenant endpoints (`GET /dashboard/tenant`,
 * `POST /dashboard/onboarding`): verify the service token + read the asserted
 * WorkOS org, but do NOT require a tenant (those endpoints exist precisely for
 * the org-without-a-tenant onboarding case). Pure — no DB lookup.
 */
const authenticateDashboardOrg = async (
  _cfg: ApiConfig,
  req: FastifyRequest,
): Promise<DashboardOrgAuthResult> => {
  const verifier = getDashboardVerifier(req);
  if (!verifier) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = await authenticateDashboardToken(
    req.headers as Record<string, string | undefined>,
    verifier,
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  return {
    ok: true,
    organizationId: parsed.organizationId,
    userId: parsed.userId,
  };
};

/** Read a non-empty string query/param value, else undefined. */
const strField = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = source[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

/**
 * Read a repeatable query value as a list. Fastify's parser yields a string for
 * a single key, a string[] for a repeated key, and undefined when absent —
 * normalize all three, dropping empties. Used by the multi-select filters.
 */
export const strList = (
  source: Record<string, unknown>,
  key: string,
): string[] => {
  const v = source[key];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter((x): x is string => typeof x === "string" && x.length > 0);
};

/**
 * Parse a JSON request body. The Fastify instance registers a single buffer
 * content-type parser (so webhook HMAC sees raw bytes), so POST handlers must
 * decode JSON themselves. Malformed/empty bodies yield {}.
 */
const parseJsonBody = (req: FastifyRequest): Record<string, unknown> => {
  const b = req.body as unknown;
  if (!b) return {};
  try {
    const text = Buffer.isBuffer(b)
      ? b.toString("utf8")
      : typeof b === "string"
        ? b
        : "";
    const parsed = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const makeLegalAcceptance = (
  acceptedByUserId: string | undefined,
): LegalAcceptance => ({
  dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
  dpaVersion: DPA_VERSION,
  acceptedAt: new Date().toISOString(),
  acceptedByUserId: acceptedByUserId ?? null,
});

const tenantHasCurrentLegalAcceptance = (
  tenantId: string,
  layer: ApiLayer,
): Promise<boolean> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(tenantId));
        return legalAcceptanceIsCurrent(settings.legalAcceptance);
      }).pipe(Effect.catchAll(() => Effect.succeed(false))),
      layer,
    ),
  );

const sendLegalAcceptanceRequired = (res: FastifyReply): FastifyReply =>
  sendJson(res, 403, { error: "legal_acceptance_required" });

// GET /dashboard/today — Today-view rollup.
const handleDashboardToday = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const summary = await runWithDb(layer, (db) =>
    todaySummary(db, auth.tenantId),
  );
  return sendJson(res, 200, summary);
};

// GET /dashboard/cases?q=&page=&limit= — paginated cases list, optional search.
const handleDashboardCases = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    casesList(
      db,
      auth.tenantId,
      { q: strField(q, "q") },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id — case + timeline + approvals.
const handleDashboardCaseDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    caseDetail(db, auth.tenantId, id),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id/conversation-thread — live provider thread for the
// third case-timeline view. The case lookup is tenant-scoped before any
// provider call, and connector failures degrade to a stable UI result.
const handleDashboardCaseConversationThread = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const conversation = yield* ConversationService;
        const connectorStore = yield* ConnectorCredentialStore;
        const caseRow = yield* cases
          .getById(CaseId(id), TenantId(auth.tenantId))
          .pipe(Effect.catchTag("CaseNotFound", () => Effect.succeed(null)));
        if (!caseRow) return { kind: "not_found" as const };
        if (!caseRow.threadId) {
          return {
            kind: "result" as const,
            result: {
              status: "unavailable" as const,
              reason: "no_thread" as const,
            },
          };
        }
        const threadId = caseRow.threadId;
        const rawThreadId = parseThreadId(threadId)?.raw ?? threadId;
        const provider =
          parseThreadId(threadId)?.provider ??
          (yield* cases.findThreadProvider(TenantId(auth.tenantId), threadId));
        const connections = yield* connectorStore.listForTenant(
          TenantId(auth.tenantId),
        );
        const threadResult = yield* resolveCaseConversationThread(
          caseRow.mailbox,
          provider,
          connections,
          (candidateProvider, mailbox) =>
            conversation.fetchThread(
              TenantId(auth.tenantId),
              namespaceThreadId(candidateProvider, rawThreadId),
              mailbox,
            ),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              status: "unavailable" as const,
              reason: conversationUnavailableReason(error),
            }),
            onSuccess: (resolution) =>
              resolution.ok
                ? {
                    status: "available" as const,
                    thread: projectConversationThread(resolution.thread),
                  }
                : {
                    status: "unavailable" as const,
                    reason: resolution.reason,
                  },
          }),
        );
        return { kind: "result" as const, result: threadResult };
      }),
      layer,
    ),
  );
  if (result.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, result.result);
};

// GET /dashboard/cases/:id/events?since= — audit rows after `since` (poll).
const handleDashboardCaseEvents = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const sinceRaw = strField((req.query ?? {}) as Record<string, unknown>, "since");
  let since = 0n;
  try {
    if (sinceRaw) since = BigInt(sinceRaw);
  } catch {
    since = 0n;
  }
  const result = await runWithDb(layer, (db) =>
    caseEvents(db, auth.tenantId, id, since),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/approvals?status=&risk=&tool=&agent=&page=&limit=
// status/risk/tool/agent are repeatable (multi-select); absent status → pending.
const handleDashboardApprovals = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    approvalsList(
      db,
      auth.tenantId,
      {
        status: strList(q, "status"),
        risk: strList(q, "risk"),
        tool: strList(q, "tool"),
        agent: strList(q, "agent"),
      },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// GET /dashboard/approvals/:id — full approval.
const handleDashboardApprovalDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    approvalDetail(db, auth.tenantId, id),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id/shopify — case-detail Shopify panels (customer +
// order + active shop domain). Best-effort: Shopify failures yield nulls.
const handleDashboardCaseShopify = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        const ctx = yield* Effect.promise(() =>
          caseContextForTenant(db, auth.tenantId, id),
        );
        if (!ctx) return { kind: "not_found" as const };
        const context = (ctx.context ?? {}) as Record<string, unknown>;
        const shopDomain = yield* Effect.promise(() =>
          activeShopifyShopDomain(db, auth.tenantId),
        );
        const order = yield* resolveOrderForContext(
          TenantId(auth.tenantId),
          context,
        );
        const customer = yield* resolveCustomerForContext(
          TenantId(auth.tenantId),
          context,
        );
        return { kind: "ok" as const, customer, order, shopDomain };
      }),
      layer,
    ),
  );
  if (result.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, {
    customer: result.customer,
    order: result.order,
    shopDomain: result.shopDomain,
  });
};

// GET /dashboard/usage?start=&end= — raw llm.decision rows in a window for
// the settings/usage page (the dashboard applies pricing + aggregation).
const handleDashboardUsage = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const parseDate = (raw: string | undefined, fallback: number): Date => {
    if (!raw) return new Date(fallback);
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  };
  // Default window: trailing ~31 days when the client omits bounds.
  const start = parseDate(strField(q, "start"), now - 31 * 86_400_000);
  const end = parseDate(strField(q, "end"), now);
  const rows = await runWithDb(layer, (db) =>
    usageRows(db, auth.tenantId, start, end),
  );
  return sendJson(res, 200, { rows });
};

// GET /dashboard/agent-overrides — per-agent model overrides (settings/agents).
const handleDashboardAgentOverrides = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const overrides = await runWithDb(layer, (db) =>
    agentOverrides(db, auth.tenantId),
  );
  return sendJson(res, 200, { overrides });
};

// GET /dashboard/connections — connector connections for the integrations
// pages + the case-detail Shopify shop-domain deep link.
const handleDashboardConnections = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const connections = await runWithDb(layer, (db) =>
    connectionsList(db, auth.tenantId),
  );
  return sendJson(res, 200, { connections });
};

// GET /dashboard/shopify-app — whether the tenant can start a Shopify
// connect. In pilot custom distribution the Connect button gates on an
// operator-provisioned custom app; in SaaS it's always available.
const handleDashboardShopifyApp = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        return yield* store.get(TenantId(auth.tenantId));
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "lookup_failed",
      detail: opaqueCause(exit.cause),
    });
  }
  const row = exit.value;
  // `available` mirrors the authoritative install/mint gate
  // (resolveShopifyAppForTenant) instead of re-deriving it from the row, so
  // the Connect button can never be enabled for a workspace whose install
  // would be refused — and never enabled by a fallback the gate forbids.
  const app = await resolveTenantShopifyApp(cfg, layer, auth.tenantId);
  return sendJson(res, 200, {
    requiresProvisioning: cfg.shopifyConnectRequiresProvisioning,
    provisioned: row !== null && row.status !== "revoked",
    status: row?.status ?? null,
    available: app.kind === "ok",
  });
};

// GET /dashboard/audit?action=&actor=&page=&limit= — cross-case audit log.
const handleDashboardAudit = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    auditList(
      db,
      auth.tenantId,
      { action: strField(q, "action"), actor: strField(q, "actor") },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/approvals/:id/{approve,reject} — manager decision. Reuses
// the same applyApprovalDecision + decisionToEvent + pg-boss publish as the
// email-link flow, but tenant-scoped and with the real manager id. Body may
// carry { approvedInput } for edit-and-approve.
const handleDashboardApprovalAction =
  (action: "approve" | "reject") =>
  async (
    cfg: ApiConfig,
    layer: ApiLayer,
    req: FastifyRequest,
    res: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = await authenticateDashboard(cfg, layer, req);
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
    if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
    const { id } = req.params as { id: string };
    // Route guard already enforced approvals.decide. Approving a refund-bearing
    // action additionally requires refunds.issue (rejecting one does not — it
    // moves no money). Open mode / owner short-circuit inside decideAuthz.
    if (action === "approve") {
      const detail = await runWithDb(layer, (db) =>
        approvalDetail(db, auth.tenantId, id),
      );
      if (detail && detail.tool === "refund.create") {
        const access = await runWithDb(layer, (db) =>
          getMemberAccess(db, auth.tenantId, auth.userId!),
        );
        const decision = decideAuthz(access, auth.userId, "refunds.issue");
        if (!decision.ok) {
          return sendJson(res, decision.status, { error: decision.error });
        }
      }
    }
    const approvedInput = parseJsonBody(req)["approvedInput"];
    const managerId = UserId(auth.userId);
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: id,
          action,
          managerId,
          tenantId: TenantId(auth.tenantId),
          ...(approvedInput !== undefined ? { approvedInput } : {}),
        }),
        layer,
      ),
    );
    const event = decisionToEvent(result, action, managerId);
    if (event) {
      try {
        await makePgBossApprovalPublisher(() =>
          acquireApprovalBoss(cfg.databaseUrl),
        )(event);
      } catch (cause) {
        // Row already decided; the worker just won't pick it up until ops
        // replays. Don't fail the request over a publish hiccup.
        // eslint-disable-next-line no-console
        console.error(
          "[dashboard approvals] publish failed; row decided without event",
          { approvalId: id, cause },
        );
      }
    }
    const status =
      result.kind === "approval_not_found"
        ? 404
        : result.kind === "expired"
          ? 410
          : 200;
    return sendJson(res, status, result);
  };

// POST /dashboard/cases/:id/takeover — manager takes over a case.
const handleDashboardTakeover = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const managerId = auth.userId;
  const outcome = await runWithDb(layer, (db) =>
    takeOverCase(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/resume — manager hands a taken-over case back
// to the agent. The status flips out of `human_takeover` so the runtime's
// takeover guard stops holding events and the agent resumes on the next
// inbound message.
const handleDashboardResume = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const managerId = auth.userId;
  const outcome = await runWithDb(layer, (db) =>
    resumeCase(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/retry — manager hands a taken-over case back
// AND has the agent try again immediately: the resume flip plus a
// `case.resumed` workflow event, so the worker ticks now instead of
// waiting for the customer's next message.
const handleDashboardRetry = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const managerId = auth.userId;
  const outcome = await retryCaseNow({
    caseId: id,
    resume: () =>
      runWithDb(layer, (db) =>
        resumeCase(db, {
          caseId: id,
          tenantId: auth.tenantId,
          managerId,
          reason: "manager asked the agent to retry from the dashboard",
        }),
      ),
    publish: makePgBossApprovalPublisher(() =>
      acquireApprovalBoss(cfg.databaseUrl),
    ),
  });
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// ---- Account deletion (tenant self-service + admin) ----

type DeleteAccountResult =
  | { readonly kind: "tenant_not_found" }
  // Could not read the tenant's connector grants for revocation, OR could not
  // schedule the cleanup job. Both happen BEFORE the wipe, so NOTHING was
  // deleted — the caller can safely retry (audit re-audit #1c).
  | { readonly kind: "capture_failed" }
  | { readonly kind: "enqueue_failed" }
  | {
      readonly kind: "deleted";
      readonly tenantId: string;
      readonly deletedCases: number;
      readonly deletedAuditRows: number;
      readonly deletedConnectorRows: number;
      readonly workosOrganizationId: string | null;
      readonly cleanupEnqueued: boolean;
    };

// Lazily-built cleanup publisher, memoized so the queue is ensured once
// per process (not per delete). Reuses the same cached pg-boss instance
// as the approval-link publisher.
let cachedCleanupPublisher:
  | ((data: AccountCleanupJobData) => Promise<string | null>)
  | null = null;
const accountCleanupPublisher = (
  databaseUrl: string,
): ((data: AccountCleanupJobData) => Promise<string | null>) => {
  if (!cachedCleanupPublisher) {
    cachedCleanupPublisher = makePgBossAccountCleanupPublisher(() =>
      acquireApprovalBoss(databaseUrl),
    );
  }
  return cachedCleanupPublisher;
};

// Lazily-built, process-memoized publisher for the post-connect Shopify policy
// import. Reuses the shared pg-boss instance (same as the approval + cleanup
// publishers).
let cachedPolicyImportPublisher:
  | ((data: ShopifyPolicyImportJobData) => Promise<string | null>)
  | null = null;
const shopifyPolicyImportPublisher = (
  databaseUrl: string,
): ((data: ShopifyPolicyImportJobData) => Promise<string | null>) => {
  if (!cachedPolicyImportPublisher) {
    cachedPolicyImportPublisher = makePgBossShopifyPolicyImportPublisher(() =>
      acquireApprovalBoss(databaseUrl),
    );
  }
  return cachedPolicyImportPublisher;
};

/**
 * Shared by the dashboard self-service + admin delete paths. Captures the
 * WorkOS org + notification email, wipes every tenant row (`redactShop`,
 * one tx), then enqueues the cleanup job (WorkOS org delete + deletion
 * email) for the worker. The DB wipe is the critical, atomic step — if the
 * enqueue fails the data is already gone, so we log + report
 * `cleanupEnqueued:false` rather than fail the request (which would falsely
 * imply nothing happened).
 */
/**
 * Capture the tenant's OAuth grants and encrypt their tokens for the cleanup
 * job (audit B1). Must run BEFORE redactShop — once the connector rows are
 * wiped these are unrecoverable.
 *
 * Captures grants in ANY status, not just `active` (re-audit #1a): a locally
 * disconnected/`revoked` row can still have a LIVE provider-side grant that
 * must be revoked. Returns `null` if the rows can't be read — the caller then
 * aborts the deletion WITHOUT wiping (re-audit #1c) so it stays retriable
 * rather than silently dropping revocation and destroying the data anyway.
 */
const captureConnectorGrants = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  tenantId: string,
): Promise<ReadonlyArray<EncryptedConnectorGrant> | null> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(tenantId));
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} could not read connector grants for revocation:`,
      Cause.pretty(exit.cause),
    );
    return null;
  }
  const enc = (s: string): string =>
    encrypt(cfg.encryptionKey, s).toString("base64");
  return buildConnectorGrants(exit.value, enc);
};

/**
 * Delete a tenant. Ordering is deliberate (re-audit #1c): capture grants →
 * enqueue the cleanup job → THEN wipe. A capture or enqueue failure happens
 * BEFORE the wipe, so nothing is destroyed and the caller can retry. Only once
 * the cleanup (revoke grants + delete WorkOS org + email) is durably queued do
 * we wipe the data. The worker's cleanup will not perform any destructive
 * action until it confirms the tenant rows are actually gone (its deletion
 * gate), so a slow or failed wipe here can never trigger premature revocation
 * / org deletion / email.
 */
const deleteTenantAccount = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  tenantId: string,
  // Operator identity for the surviving admin-audit record (re-audit #2):
  // "admin" (platform console) or "tenant_self" (dashboard self-service).
  actor: string,
  // Workspace semantics: a single-workspace delete must neither delete the
  // shared WorkOS org nor email the owner; the org is only ever deleted
  // along with its LAST workspace (resolveCleanupTargets).
  opts: { readonly allowOrgDelete: boolean; readonly sendEmail: boolean },
): Promise<DeleteAccountResult> => {
  const snapshot = await runWithDb(layer, (db) =>
    tenantDeletionSnapshot(db, tenantId),
  );
  if (!snapshot) return { kind: "tenant_not_found" };

  const orgWorkspaceCount = snapshot.workosOrganizationId
    ? (
        await runWithDb(layer, (db) =>
          listWorkspacesByWorkosOrg(db, snapshot.workosOrganizationId!),
        )
      ).length
    : 0;
  const targets = resolveCleanupTargets(snapshot, { ...opts, orgWorkspaceCount });

  // 1. Capture provider grants (any status) before anything is destroyed.
  const connectorGrants = await captureConnectorGrants(cfg, layer, tenantId);
  if (connectorGrants === null) return { kind: "capture_failed" };

  // 2. Durably queue the cleanup (revoke + org delete + email) BEFORE the
  //    wipe, so an enqueue failure leaves all data intact and retriable.
  let cleanupJobId: string | null;
  try {
    cleanupJobId = await accountCleanupPublisher(cfg.databaseUrl)({
      tenantId: snapshot.id,
      tenantName: snapshot.name,
      workosOrganizationId: targets.workosOrganizationId,
      notificationEmail: targets.notificationEmail,
      connectorGrants,
    });
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} cleanup enqueue failed (NOT wiped, safe to retry):`,
      cause,
    );
    return { kind: "enqueue_failed" };
  }
  // No job id → the send was suppressed/no-op (e.g. a dedup policy collapsed
  // it onto an existing job that may carry STALE creds). Do NOT wipe — that
  // would destroy the only copy of this attempt's grants (5th-audit #1).
  if (!cleanupJobId) {
    // eslint-disable-next-line no-console
    console.error(
      `[account-delete] tenant=${tenantId} cleanup not queued (no job id); NOT wiping, safe to retry`,
    );
    return { kind: "enqueue_failed" };
  }

  // 3. Wipe every tenant row (atomic), recording a SURVIVING admin-audit
  //    row in the same transaction (re-audit #2).
  const wipe = await Effect.runPromise(
    Effect.provide(
      redactShop(tenantId, {
        action: "tenant.deleted",
        actor,
        details: {
          tenantName: snapshot.name,
          workosOrganizationId: snapshot.workosOrganizationId,
          scope: opts.allowOrgDelete ? "account" : "workspace",
          orgDeleted: targets.workosOrganizationId !== null,
        },
      }),
      layer,
    ),
  );

  return {
    kind: "deleted",
    tenantId,
    deletedCases: wipe.deletedCases,
    deletedAuditRows: wipe.deletedAuditRows,
    deletedConnectorRows: wipe.deletedConnectorRows,
    // The org the cleanup job will actually delete (null when suppressed —
    // workspace-scoped delete, or sibling workspaces still use the org).
    workosOrganizationId: targets.workosOrganizationId,
    cleanupEnqueued: true,
  };
};

// HTTP status for a delete outcome. `capture_failed`/`enqueue_failed` are
// pre-wipe aborts (nothing destroyed) → 503 so the caller retries.
const deleteResultStatus = (result: DeleteAccountResult): number => {
  switch (result.kind) {
    case "tenant_not_found":
      return 404;
    case "capture_failed":
    case "enqueue_failed":
      return 503;
    case "deleted":
      return 200;
  }
};

// POST /dashboard/account/delete — a manager deletes their WHOLE account:
// every workspace the org owns, newest first so the DEFAULT (oldest) goes
// last and is the only one whose cleanup job deletes the WorkOS org and
// emails the owner. A mid-sweep failure aborts BEFORE that workspace's wipe
// (capture/enqueue precede it), so the remainder — org included — is intact
// and the request is retriable.
const handleDashboardAccountDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  if (workspaces.length === 0) {
    return sendJson(res, 403, { error: "no_tenant_for_organization" });
  }
  const order = [...workspaces].reverse(); // default (oldest) last
  let deletedWorkspaces = 0;
  const totals = {
    deletedCases: 0,
    deletedAuditRows: 0,
    deletedConnectorRows: 0,
  };
  let last: Extract<DeleteAccountResult, { kind: "deleted" }> | null = null;
  for (const ws of order) {
    const isFinal = ws === order[order.length - 1];
    const result = await deleteTenantAccount(cfg, layer, ws.id, "tenant_self", {
      allowOrgDelete: true, // suppressed by the last-workspace rule until final
      sendEmail: isFinal,
    });
    // Already gone (another tab won this workspace) — keep sweeping.
    if (result.kind === "tenant_not_found") continue;
    if (result.kind !== "deleted") {
      return sendJson(res, deleteResultStatus(result), {
        ...result,
        deletedWorkspaces,
      });
    }
    deletedWorkspaces += 1;
    totals.deletedCases += result.deletedCases;
    totals.deletedAuditRows += result.deletedAuditRows;
    totals.deletedConnectorRows += result.deletedConnectorRows;
    last = result;
  }
  if (!last) {
    // Everything vanished mid-flight (concurrent delete) — org has no tenant.
    return sendJson(res, 403, { error: "no_tenant_for_organization" });
  }
  return sendJson(res, 200, {
    ...last,
    ...totals,
    deletedWorkspaces,
  });
};

// POST /admin/tenants/:id/delete — platform operator deletes ANY single
// tenant (workspace). The deletion email still goes out; the WorkOS org is
// deleted only when this is the org's last workspace (the last-workspace
// rule in resolveCleanupTargets), so deleting one of two workspaces can't
// kill the sibling's login.
const handleAdminTenantDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  if (!cfg.adminApiToken) {
    return sendJson(res, 503, { error: "admin_api_not_configured" });
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.message });
  const { id } = req.params as { id: string };
  const result = await deleteTenantAccount(cfg, layer, id, "admin", {
    allowOrgDelete: true,
    sendEmail: true,
  });
  return sendJson(res, deleteResultStatus(result), result);
};

// ---- Admin: per-tenant Shopify custom-app provisioning (pilot) ----

/**
 * Guard the `/admin/tenants/:id/shopify-app` routes: require the configured
 * admin bearer token. Returns the tenant id on success, or `null` after
 * having already sent the error response.
 */
const adminShopifyAppGuard = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): string | null => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return null;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return null;
  }
  return (req.params as { id: string }).id;
};

// PUT /admin/tenants/:id/shopify-app — operator sets the tenant's Shopify
// custom-app client_id + client_secret (pilot custom distribution).
const handleAdminShopifyAppPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const body = parseJsonBody(req);
  const clientId = typeof body["clientId"] === "string" ? body["clientId"].trim() : "";
  const clientSecret =
    typeof body["clientSecret"] === "string" ? body["clientSecret"] : "";
  if (!clientId || !clientSecret) {
    sendJson(res, 400, { error: "missing_client_credentials" });
    return;
  }
  // Optional store domain (A4). When given it's normalized + recorded so the
  // install flow can use the standard authorize URL and a no-state callback
  // resolves the tenant. An invalid value is rejected rather than ignored.
  const rawShop =
    typeof body["shopDomain"] === "string" ? body["shopDomain"].trim() : "";
  let shopDomain: string | undefined;
  if (rawShop) {
    const normalized = normalizeShopDomain(rawShop);
    if (!normalized) {
      sendJson(res, 400, { error: "invalid_shop", shop: rawShop });
      return;
    }
    shopDomain = normalized;
  }
  // F1: in pilot mode the store domain is REQUIRED at provisioning. The
  // merchant install flow needs it to build the proven OAuth authorize URL —
  // without it the only fallback is the admin.shopify.com managed-install
  // store picker, whose re-entry needs the global app secret to verify its
  // HMAC, which pure-pilot mode forbids. So an un-installable shop-less row
  // must be refused here rather than created. (SaaS mode keeps it optional.)
  if (cfg.shopifyConnectRequiresProvisioning && !shopDomain) {
    sendJson(res, 400, { error: "shop_domain_required" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      putAdminShopifyApp({
        tenantId,
        clientId,
        clientSecret,
        ...(shopDomain ? { shopDomain } : {}),
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, {
      error: "provisioning_failed",
      detail: opaqueCause(exit.cause),
    });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "shop_conflict") {
    sendJson(res, 409, {
      error: "shop_already_connected",
      shop: exit.value.shopDomain,
    });
    return;
  }
  sendJson(res, 200, { ok: true, provisioning: exit.value.provisioning });
};

// GET /admin/tenants/:id/shopify-app — read provisioning status (no secret).
const handleAdminShopifyAppGet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(getAdminShopifyApp(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "lookup_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "not_provisioned") {
    sendJson(res, 200, { ok: true, provisioned: false, provisioning: null });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    provisioned: true,
    provisioning: exit.value.provisioning,
  });
};

// DELETE /admin/tenants/:id/shopify-app — revoke provisioning (offboarding).
const handleAdminShopifyAppDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminShopifyApp(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  if (exit.value.kind === "not_provisioned") {
    sendJson(res, 404, { error: "not_provisioned" });
    return;
  }
  // Offboarding the app also revokes the merchant's LIVE Shopify access
  // token provider-side, not just the provisioning row (5th-audit #3).
  const grants = await Effect.runPromise(
    Effect.provide(
      revokeConnectorProviderGrants(TenantId(tenantId), "shopify", tenantId),
      layer,
    ),
  );
  sendJson(res, 200, {
    ok: true,
    provisioning: exit.value.provisioning,
    connectorRevoked: grants.revoked,
    providerRevoked: grants.providerRevoked,
  });
};

// POST /admin/tenants/:id/shopify-app/pcd-check — live protected-customer-data
// probe: read a few recent orders through the tenant's connected store and
// report whether customer PII comes back populated or redacted. Custom
// distribution needs no Shopify review, but the app must still DECLARE its
// PCD fields in the Dev Dashboard or Shopify redacts them on live stores.
const handleAdminShopifyAppPcdCheck = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(checkAdminShopifyAppPcd(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 502, { error: "pcd_check_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (exit.value.kind === "tenant_not_found") {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  sendJson(res, 200, { ok: true, result: exit.value });
};

// GET /admin/tenants — list every tenant for the operator admin app.
const handleAdminTenantsList = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(listTenantsForAdmin(), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "list_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  sendJson(res, 200, { tenants: exit.value });
};

// GET /admin/tenants/:id — operator detail for one tenant (no secrets).
const handleAdminTenantDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(getTenantDetailForAdmin(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "detail_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (!exit.value) {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  sendJson(res, 200, exit.value);
};

const adminMutationResponse = (
  res: FastifyReply,
  result: AdminOpenRouterMutationResult,
): void => {
  if (result.kind === "not_found") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (result.kind === "not_configured") {
    sendJson(res, 404, { error: "not_configured" });
    return;
  }
  if (result.kind === "legal_acceptance_required") {
    sendJson(res, 403, { error: "legal_acceptance_required" });
    return;
  }
  sendJson(res, 200, { ok: true });
};

const adminAuthorized = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): boolean => {
  if (!cfg.adminApiToken) {
    sendJson(res, 503, { error: "admin_api_not_configured" });
    return false;
  }
  const parsed = parseAdminAuth(
    req.headers as Record<string, string | undefined>,
    cfg.adminApiToken,
  );
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.message });
    return false;
  }
  return true;
};

const handleAdminAccountDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const exit = await Effect.runPromiseExit(
    Effect.provide(getAdminAccountDetail(organizationId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "detail_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  if (!exit.value) {
    sendJson(res, 404, { error: "account_not_found" });
    return;
  }
  sendJson(res, 200, exit.value);
};

const handleAdminAccountOpenRouterPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const body = parseJsonBody(req);
  const apiKey =
    typeof body["apiKey"] === "string" ? String(body["apiKey"]).trim() : "";
  if (apiKey.length < 8) {
    sendJson(res, 400, { error: "missing_key" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(putAdminAccountOpenRouter(organizationId, apiKey), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "save_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

const handleAdminAccountOpenRouterDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!adminAuthorized(cfg, req, res)) return;
  const { organizationId } = req.params as { organizationId: string };
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminAccountOpenRouter(organizationId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

const handleAdminWorkspaceOpenRouterPut = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const body = parseJsonBody(req);
  const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
  if (apiKey.length < 8) {
    sendJson(res, 400, { error: "missing_key" });
    return;
  }
  const exit = await Effect.runPromiseExit(
    Effect.provide(putAdminWorkspaceOpenRouter(tenantId, apiKey), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "save_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

const handleAdminWorkspaceOpenRouterDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const tenantId = adminShopifyAppGuard(cfg, req, res);
  if (!tenantId) return;
  const exit = await Effect.runPromiseExit(
    Effect.provide(revokeAdminWorkspaceOpenRouter(tenantId), layer),
  );
  if (exit._tag !== "Success") {
    sendJson(res, 500, { error: "revoke_failed", detail: opaqueCause(exit.cause) });
    return;
  }
  adminMutationResponse(res, exit.value);
};

// ---- Dashboard catalog / models / tenant (reads) ----

// GET /dashboard/catalog — static agent + tool inventory (settings pages).
const handleDashboardCatalog = async (
  cfg: ApiConfig,
  _layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  return sendJson(res, 200, buildCatalogResponse(ALL_AGENTS, ALL_TOOLS));
};

// GET /dashboard/models — the tenant's LLM model catalog. The decrypted key
// is resolved + used server-side; only the model list reaches the client.
const handleDashboardModels = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const cred = await Effect.runPromise(
    Effect.provide(resolveActiveLlmCredential(auth.tenantId), layer),
  );
  if (!cred) return sendJson(res, 200, buildModelsResponse(null, null));
  const catalog = await fetchModelCatalog({
    provider: cred.provider,
    apiKey: cred.apiKey,
    ...(cred.baseURL !== undefined ? { baseURL: cred.baseURL } : {}),
  });
  return sendJson(res, 200, buildModelsResponse(cred, catalog));
};

const handleDashboardLlmStatus = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const status = await Effect.runPromise(
    Effect.provide(resolveLlmCredentialStatus(auth.tenantId), layer),
  );
  return sendJson(res, 200, status);
};

// GET /dashboard/tenant — the org's tenant (or null → dashboard sends to
// onboarding). Token + org auth; does NOT require an existing tenant.
const handleDashboardTenant = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tenant = await runWithDb(layer, (db) =>
    tenantByWorkosOrg(db, auth.organizationId),
  );
  return sendJson(res, 200, {
    tenant: tenant ? { tenantId: tenant.id, name: tenant.name } : null,
  });
};

// GET /dashboard/workspaces — every workspace (tenant row) the org owns,
// default first. Org-auth on purpose: the switcher must render (empty) for
// an org that hasn't onboarded its first workspace yet, and the dashboard's
// context gate maps the empty list to /onboarding itself.
const handleDashboardWorkspaces = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  return sendJson(res, 200, {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      shopifyDomain: w.shopifyDomain,
    })),
    defaultWorkspaceId: workspaces[0]?.id ?? null,
  });
};

// POST /dashboard/workspaces — mint an ADDITIONAL workspace under the org.
// The org's current legal acceptance is copied verbatim onto the new row
// (who/when preserved): the connector gates hard-require a current
// acceptance per tenant row, so a workspace minted without one could never
// connect anything. No current acceptance anywhere → the manager re-accepts
// first (403, same signal the legal page already handles). Zero workspaces →
// onboarding owns first-workspace creation (409).
const handleDashboardWorkspaceCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const email =
    typeof body["notificationEmail"] === "string"
      ? body["notificationEmail"].trim()
      : "";
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  if (!email.includes("@")) return sendJson(res, 400, { error: "bad_email" });

  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  if (workspaces.length === 0) {
    return sendJson(res, 409, { error: "use_onboarding" });
  }
  // First current acceptance among the org's workspaces (default first) —
  // scanning all avoids a dead end when only a newer workspace re-accepted.
  let acceptance: LegalAcceptance | null = null;
  for (const ws of workspaces) {
    const candidate = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          const settings = yield* repo.getSettings(TenantId(ws.id));
          return settings.legalAcceptance;
        }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        layer,
      ),
    );
    if (legalAcceptanceIsCurrent(candidate)) {
      acceptance = candidate;
      break;
    }
  }
  if (!acceptance) return sendLegalAcceptanceRequired(res);

  const result = await runWithDb(layer, (db) =>
    createWorkspaceForOrg(db, {
      organizationId: auth.organizationId,
      name: name.slice(0, 120),
      notificationEmail: email.slice(0, 254),
      legalAcceptance: acceptance,
    }),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/workspaces/:id/rename — names are load-bearing (delete
// confirmations match on them), so renames go through the same org-ownership
// check as everything else. Foreign/unknown → 404, like the auth path.
const handleDashboardWorkspaceRename = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!isWorkspaceIdShape(id)) {
    return sendJson(res, 400, { error: "invalid_workspace_id" });
  }
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  const renamed = await runWithDb(layer, (db) =>
    renameWorkspaceForOrg(db, {
      organizationId: auth.organizationId,
      workspaceId: id,
      name: name.slice(0, 120),
    }),
  );
  if (!renamed) return sendJson(res, 404, { error: "workspace_not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/workspaces/:id/delete — wipe ONE workspace. The WorkOS
// org and sibling workspaces survive (allowOrgDelete: false), and no
// deletion email goes out. The LAST workspace is refused — deleting it is
// account deletion, which has its own flow and confirmation.
const handleDashboardWorkspaceDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!isWorkspaceIdShape(id)) {
    return sendJson(res, 400, { error: "invalid_workspace_id" });
  }
  const owned = await runWithDb(layer, (db) =>
    findWorkspaceForOrg(db, auth.organizationId, id),
  );
  if (!owned) return sendJson(res, 404, { error: "workspace_not_found" });
  const count = (
    await runWithDb(layer, (db) =>
      listWorkspacesByWorkosOrg(db, auth.organizationId),
    )
  ).length;
  if (count <= 1) return sendJson(res, 409, { error: "last_workspace" });
  const result = await deleteTenantAccount(cfg, layer, id, "tenant_self", {
    allowOrgDelete: false,
    sendEmail: false,
  });
  return sendJson(res, deleteResultStatus(result), result);
};

// GET /dashboard/shop-currency — best-effort store currency (ISO 4217) for
// the refund-policy page's currency-mismatch warning. Null when there's no
// live Shopify connection or the lookup fails; the page just omits the hint.
const handleDashboardShopCurrency = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const currencyCode = await Effect.runPromise(
    Effect.provide(resolveShopCurrencyCode(TenantId(auth.tenantId)), layer),
  );
  return sendJson(res, 200, { currencyCode });
};

// GET /dashboard/settings — resolved tenant settings (refund policy +
// supplier-escalation sheet + notification email + retention). Defaults are
// applied by getSettings; a transient error falls back to platform defaults.
const handleDashboardSettings = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const settings = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        return yield* repo.getSettings(TenantId(auth.tenantId));
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            retentionDays: DEFAULT_RETENTION_DAYS,
            supplierEscalationSheet: null,
            legalAcceptance: null,
          } as const),
        ),
      ),
      layer,
    ),
  );
  return sendJson(res, 200, {
    notificationEmail: settings.notificationEmail,
    refundPolicy: settings.refundPolicy,
    retentionDays: settings.retentionDays,
    supplierEscalationSheet: settings.supplierEscalationSheet,
    legalAcceptance: settings.legalAcceptance,
  });
};

// ---- Dashboard settings (writes) ----

const LLM_PROVIDER_SET: ReadonlySet<string> = new Set([
  "openrouter",
  "anthropic",
  "openai",
]);
const isLlmProviderName = (p: string): p is LLMProvider =>
  LLM_PROVIDER_SET.has(p);

const CONNECTOR_PROVIDERS = [
  "shopify",
  "gmail",
  "google_sheets",
  "outlook",
  "imap",
  "telegram",
] as const;
type DisconnectProvider = (typeof CONNECTOR_PROVIDERS)[number];
const isDisconnectProvider = (p: string): p is DisconnectProvider =>
  (CONNECTOR_PROVIDERS as ReadonlyArray<string>).includes(p);

// A1 reference with mandatory sheet-name prefix (mirrors the dashboard's
// supplier-escalation form validation).
const SUPPLIER_RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

// POST /dashboard/onboarding — create a tenant for the asserted org.
const handleDashboardOnboarding = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const email =
    typeof body["notificationEmail"] === "string"
      ? body["notificationEmail"].trim()
      : "";
  const legalAccepted = body["legalAccepted"] === true;
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  if (!email.includes("@")) return sendJson(res, 400, { error: "bad_email" });
  if (!legalAccepted) {
    return sendJson(res, 400, { error: "legal_acceptance_required" });
  }
  const result = await runWithDb(layer, (db) =>
    createTenantForOrg(db, {
      organizationId: auth.organizationId,
      name: name.slice(0, 120),
      notificationEmail: email.slice(0, 254),
      legalAcceptance: makeLegalAcceptance(auth.userId),
    }),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/legal-acceptance — accept the current legal notice + DPA
// for an existing tenant (used by tenants created before the gate shipped).
const handleDashboardLegalAcceptance = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setLegalAcceptance(
          TenantId(auth.tenantId),
          makeLegalAcceptance(auth.userId),
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/model — set a per-agent model override.
const handleDashboardAgentModelSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  const body = parseJsonBody(req);
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  if (!model) return sendJson(res, 400, { error: "missing_model" });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.setModel(TenantId(auth.tenantId), AgentId(id), model);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/model/clear — drop the override (→ config default).
const handleDashboardAgentModelClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearModel(TenantId(auth.tenantId), AgentId(id));
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/system-prompt — set the tenant's custom prompt
// (appended to the agent's built-in prompt). A blank body clears it, so the
// dashboard can "save empty" to revert without a separate request.
const handleDashboardAgentSystemPromptSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  const body = parseJsonBody(req);
  const systemPrompt =
    typeof body["systemPrompt"] === "string" ? body["systemPrompt"].trim() : "";
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        if (systemPrompt) {
          yield* svc.setSystemPrompt(
            TenantId(auth.tenantId),
            AgentId(id),
            systemPrompt,
          );
        } else {
          yield* svc.clearSystemPrompt(TenantId(auth.tenantId), AgentId(id));
        }
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/system-prompt/clear — drop the custom prompt
// (→ bare AgentConfig prompt). Keeps any model override on the same row.
const handleDashboardAgentSystemPromptClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearSystemPrompt(TenantId(auth.tenantId), AgentId(id));
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// Resolve a tenant-configurable tool for an agent, or an error code. Guards the
// tool-permission endpoints: the tool must be bound to the agent AND carry the
// `permission-toggle` control (so `refund.create`, governed by the refund-policy
// page, and internal plumbing tools are both rejected here).
const resolveConfigurableTool = (
  agentId: string,
  toolName: unknown,
):
  | { ok: true; tool: string }
  | { ok: false; status: number; error: string } => {
  const agent = ALL_AGENTS.find((a) => a.id === agentId);
  if (!agent) return { ok: false, status: 404, error: "unknown_agent" };
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { ok: false, status: 400, error: "missing_tool" };
  }
  if (!agent.tools.includes(toolName)) {
    return { ok: false, status: 400, error: "tool_not_on_agent" };
  }
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool || tool.tenantControl !== "permission-toggle") {
    return { ok: false, status: 400, error: "tool_not_configurable" };
  }
  return { ok: true, tool: toolName };
};

// POST /dashboard/agents/:id/tool-permission — set a per-agent "ask first" vs
// "auto" choice for one tool. Body: { tool, permission } where permission is
// "ask" | "allow" (tenants can never set "deny" here — that stays a policy
// outcome). The runtime overlays this onto the agent's permissionOverrides.
const handleDashboardAgentToolPermissionSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const resolved = resolveConfigurableTool(id, body["tool"]);
  if (!resolved.ok) {
    return sendJson(res, resolved.status, { error: resolved.error });
  }
  const permission = body["permission"];
  if (permission !== "ask" && permission !== "allow") {
    return sendJson(res, 400, { error: "invalid_permission" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.setToolPermission(
          TenantId(auth.tenantId),
          AgentId(id),
          resolved.tool,
          permission,
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/tool-permission/clear — drop the per-agent override
// for one tool (revert to the agent default). Body: { tool }.
const handleDashboardAgentToolPermissionClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const resolved = resolveConfigurableTool(id, body["tool"]);
  if (!resolved.ok) {
    return sendJson(res, resolved.status, { error: resolved.error });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearToolPermission(
          TenantId(auth.tenantId),
          AgentId(id),
          resolved.tool,
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// ============================================================
// Knowledge base (settings/knowledge) — policy / reference documents the
// support agents consult via the knowledge.search tool.
// ============================================================

const KB_MAX_DOCS_PER_TENANT = 50;
const KB_MAX_CONTENT_CHARS = 100_000;
const KB_MAX_TITLE_CHARS = 200;
const KB_MAX_URL_CHARS = 2_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hashContent = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** Run an effect needing only KnowledgeBaseService against the api layer. */
const runWithKnowledge = <A>(
  layer: ApiLayer,
  f: (kb: typeof KnowledgeBaseService.Service) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(KnowledgeBaseService, f),
      layer,
    ) as Effect.Effect<A, unknown, never>,
  ) as Promise<A>;

/** Fetch + extract a tenant-supplied URL via the SSRF-guarded service. */
const fetchKnowledgeUrl = (
  layer: ApiLayer,
  url: string,
): Promise<
  | { ok: true; text: string; finalUrl: string }
  | { ok: false; reason: string }
> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* UrlFetchService;
        const either = yield* svc.fetch(url).pipe(Effect.either);
        return either._tag === "Left"
          ? ({ ok: false as const, reason: either.left.kind })
          : ({
              ok: true as const,
              text: either.right.text,
              finalUrl: either.right.finalUrl,
            });
      }),
      layer,
    ),
  );

// GET /dashboard/knowledge — list document summaries (no content).
const handleDashboardKnowledgeList = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const documents = await runWithDb(layer, (db) =>
    knowledgeDocuments(db, auth.tenantId),
  );
  return sendJson(res, 200, { documents });
};

// GET /dashboard/knowledge/:id — one full document (for the editor).
const handleDashboardKnowledgeGet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, {
    document: {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      sourceType: doc.sourceType,
      sourceUrl: doc.sourceUrl,
      fetchedAt: doc.fetchedAt ? doc.fetchedAt.toISOString() : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    },
  });
};

// POST /dashboard/knowledge — create a document from pasted text or a URL.
const handleDashboardKnowledgeCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const title =
    typeof body["title"] === "string" ? body["title"].trim() : "";
  if (!title || title.length > KB_MAX_TITLE_CHARS) {
    return sendJson(res, 400, { error: "invalid_title" });
  }
  const sourceType = body["sourceType"];
  if (sourceType !== "text" && sourceType !== "url") {
    return sendJson(res, 400, { error: "invalid_source_type" });
  }

  const count = await runWithKnowledge(layer, (kb) =>
    kb.count(TenantId(auth.tenantId)),
  );
  if (count >= KB_MAX_DOCS_PER_TENANT) {
    return sendJson(res, 403, { error: "too_many_documents" });
  }

  let content: string;
  let sourceUrl: string | null = null;
  let fetchedAt: Date | null = null;

  if (sourceType === "text") {
    content = typeof body["content"] === "string" ? body["content"] : "";
    if (!content.trim()) return sendJson(res, 400, { error: "missing_content" });
    if (content.length > KB_MAX_CONTENT_CHARS) {
      return sendJson(res, 400, { error: "content_too_large" });
    }
  } else {
    const url = typeof body["sourceUrl"] === "string" ? body["sourceUrl"].trim() : "";
    if (!url || url.length > KB_MAX_URL_CHARS) {
      return sendJson(res, 400, { error: "invalid_url" });
    }
    const fetched = await fetchKnowledgeUrl(layer, url);
    if (!fetched.ok) {
      return sendJson(res, 400, { error: "fetch_failed", reason: fetched.reason });
    }
    content = fetched.text.slice(0, KB_MAX_CONTENT_CHARS);
    sourceUrl = fetched.finalUrl;
    fetchedAt = new Date();
  }

  const created = await runWithKnowledge(layer, (kb) =>
    kb.create(TenantId(auth.tenantId), {
      title,
      content,
      sourceType,
      sourceUrl,
      contentHash: hashContent(content),
      fetchedAt,
    }),
  );
  return sendJson(res, 200, { ok: true, id: created.id });
};

// POST /dashboard/knowledge/:id — edit title (any doc) and/or content (text docs).
const handleDashboardKnowledgeUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const body = parseJsonBody(req);

  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });

  const patch: {
    title?: string;
    content?: string;
    contentHash?: string;
  } = {};
  if (typeof body["title"] === "string") {
    const t = body["title"].trim();
    if (!t || t.length > KB_MAX_TITLE_CHARS) {
      return sendJson(res, 400, { error: "invalid_title" });
    }
    patch.title = t;
  }
  if (typeof body["content"] === "string") {
    if (doc.sourceType !== "text") {
      return sendJson(res, 400, { error: "cannot_edit_url_content" });
    }
    const c = body["content"];
    if (!c.trim()) return sendJson(res, 400, { error: "missing_content" });
    if (c.length > KB_MAX_CONTENT_CHARS) {
      return sendJson(res, 400, { error: "content_too_large" });
    }
    patch.content = c;
    patch.contentHash = hashContent(c);
  }

  const updated = await runWithKnowledge(layer, (kb) =>
    kb.update(TenantId(auth.tenantId), id, patch),
  );
  if (!updated) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/knowledge/:id/delete — remove a document.
const handleDashboardKnowledgeDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const removed = await runWithKnowledge(layer, (kb) =>
    kb.remove(TenantId(auth.tenantId), id),
  );
  if (!removed) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/knowledge/:id/resync — re-fetch a `url` doc's snapshot.
const handleDashboardKnowledgeResync = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) return sendJson(res, 404, { error: "not_found" });
  const doc = await runWithKnowledge(layer, (kb) =>
    kb.get(TenantId(auth.tenantId), id),
  );
  if (!doc) return sendJson(res, 404, { error: "not_found" });
  if (doc.sourceType !== "url" || !doc.sourceUrl) {
    return sendJson(res, 400, { error: "not_a_url_doc" });
  }
  const fetched = await fetchKnowledgeUrl(layer, doc.sourceUrl);
  if (!fetched.ok) {
    return sendJson(res, 400, { error: "fetch_failed", reason: fetched.reason });
  }
  const content = fetched.text.slice(0, KB_MAX_CONTENT_CHARS);
  const contentHash = hashContent(content);
  if (contentHash === doc.contentHash) {
    return sendJson(res, 200, { ok: true, changed: false });
  }
  await runWithKnowledge(layer, (kb) =>
    kb.update(TenantId(auth.tenantId), id, {
      content,
      contentHash,
      fetchedAt: new Date(),
    }),
  );
  return sendJson(res, 200, { ok: true, changed: true });
};

// POST /dashboard/llm — connect a BYOK LLM credential (api encrypts + stores).
const handleDashboardLlmConnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const provider =
    typeof body["provider"] === "string" ? body["provider"].trim() : "";
  const apiKey = typeof body["apiKey"] === "string" ? body["apiKey"].trim() : "";
  const baseURL =
    typeof body["baseURL"] === "string" ? body["baseURL"].trim() : "";
  if (!isLlmProviderName(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  if (apiKey.length < 8) return sendJson(res, 400, { error: "missing_key" });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  const tid = TenantId(auth.tenantId);
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        // At most one active LLM provider per tenant — revoke any existing
        // active LLM rows before the upsert (mirrors the dashboard action).
        const rows = yield* store.listForTenant(tid);
        const activeLlm = rows.filter(
          (r) => isLlmProviderName(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlm.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
        yield* store.put({
          tenantId: tid,
          provider,
          shopDomain: "default",
          accessToken: apiKey,
          scopes: [],
          ...(baseURL.length > 0
            ? { metadata: { baseURL } as Readonly<Record<string, unknown>> }
            : {}),
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/llm/revoke — revoke the tenant's active LLM credential(s).
const handleDashboardLlmRevoke = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tid = TenantId(auth.tenantId);
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(tid);
        const activeLlm = rows.filter(
          (r) => isLlmProviderName(r.provider) && r.status === "active",
        );
        yield* Effect.all(
          activeLlm.map((r) =>
            store.revoke(tid, r.provider as LLMProvider, r.shopDomain),
          ),
          { concurrency: 1 },
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/refund-policy — set the tenant's conditional refund rule.
const handleDashboardRefundPolicy = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const currency =
    typeof body["currencyCode"] === "string"
      ? body["currencyCode"].trim().toUpperCase()
      : "";
  const ask = body["askAboveMinorUnits"];
  const deny = body["denyAboveMinorUnits"];
  const modeRaw = body["mode"];
  const mode: RefundPolicyMode =
    modeRaw === "always_ask" || modeRaw === "always_deny"
      ? modeRaw
      : "thresholds";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { error: "bad_currency" });
  }
  if (
    typeof ask !== "number" ||
    !Number.isInteger(ask) ||
    ask < 0 ||
    typeof deny !== "number" ||
    !Number.isInteger(deny) ||
    deny < 0
  ) {
    return sendJson(res, 400, { error: "bad_amount" });
  }
  if (ask > deny) return sendJson(res, 400, { error: "bad_order" });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setRefundPolicy(TenantId(auth.tenantId), {
          askAboveMinorUnits: ask,
          denyAboveMinorUnits: deny,
          currencyCode: currency,
          mode,
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/supplier-sheet — set the missing-package escalation sheet.
const handleDashboardSupplierSheet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const spreadsheetId =
    typeof body["spreadsheetId"] === "string"
      ? body["spreadsheetId"].trim()
      : "";
  const range = typeof body["range"] === "string" ? body["range"].trim() : "";
  const description =
    typeof body["description"] === "string" ? body["description"].trim() : "";
  if (!spreadsheetId) {
    return sendJson(res, 400, { error: "missing_spreadsheet_id" });
  }
  if (!SUPPLIER_RANGE_RE.test(range)) {
    return sendJson(res, 400, { error: "bad_range" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(TenantId(auth.tenantId), {
          spreadsheetId,
          range,
          description: description.length > 0 ? description : null,
        });
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/supplier-sheet/clear — clear the escalation sheet.
const handleDashboardSupplierSheetClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(TenantId(auth.tenantId), null);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// Revoke every active connector grant for a tenant+provider PROVIDER-SIDE
// (best-effort), THEN mark the rows revoked locally (5th-audit #3 — local
// revoke alone leaves the Shopify/Google token live). A provider-side failure
// is logged but doesn't block the local revoke (the caller asked to
// disconnect). Returns how many rows were revoked locally + how many were
// confirmed gone provider-side.
const revokeConnectorProviderGrants = (
  tid: TenantId,
  provider: DisconnectProvider,
  tenantLabel: string,
): Effect.Effect<
  { readonly revoked: number; readonly providerRevoked: number },
  ConnectorNotFound | ConnectorStoreDbError,
  ConnectorCredentialStore
> =>
  Effect.gen(function* () {
    const store = yield* ConnectorCredentialStore;
    const rows = yield* store.listForTenant(tid);
    const active = rows.filter(
      (r) => r.provider === provider && r.status === "active",
    );
    let providerRevoked = 0;
    for (const r of active) {
      const result = yield* Effect.promise(() =>
        revokeConnectorGrant({
          provider,
          shopDomain: r.shopDomain,
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          apiVersion: r.apiVersion,
        }),
      );
      if (result.kind === "revoked" || result.kind === "already_gone") {
        providerRevoked += 1;
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[disconnect] tenant=${tenantLabel} provider=${provider}/${r.shopDomain} provider-side revoke failed: ${result.detail}`,
        );
      }
    }
    yield* Effect.all(
      active.map((r) => store.revoke(tid, provider, r.shopDomain)),
      { concurrency: 1 },
    );
    return { revoked: active.length, providerRevoked };
  });

// POST /dashboard/connect/:provider — mint a signed, short-lived install
// grant for the AUTHENTICATED tenant and return the provider install URL
// (5th-audit #2). Authorization comes from the dashboard's bearer token +
// x-org-id (→ org→tenant), so the tenant is derived server-side from the
// session, never supplied by the client. The install endpoints then require
// this grant instead of a raw `?tenant=`.
const handleDashboardConnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { provider } = req.params as { provider: string };
  if (!isInstallGrantProvider(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  // Shopify: refuse to mint a grant for a workspace with no resolvable app
  // (pilot workspace not provisioned / provisioning revoked / no app
  // configured at all). The install endpoint re-checks, but gating the mint
  // means the merchant is never sent into an OAuth flow that can only run on
  // credentials that don't belong to their workspace.
  if (provider === "shopify") {
    const app = await resolveTenantShopifyApp(cfg, layer, auth.tenantId);
    if (app.kind !== "ok") {
      sendShopifyAppResolveError(res, app);
      return res;
    }
  }
  // One mailbox per provider per store (same invariant as the IMAP connect
  // endpoint): refuse to start the OAuth flow while a mailbox is connected,
  // BEFORE the merchant sits through the consent screen. The callbacks
  // re-check for manual installs.
  if (provider === "gmail" || provider === "outlook") {
    const listExit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.listForTenant(TenantId(auth.tenantId));
        }),
        layer,
      ),
    );
    if (listExit._tag !== "Success") {
      return sendJson(res, 500, {
        error: "persist_failed",
        detail: opaqueCause(listExit.cause),
      });
    }
    const conflict = activeMailboxConflict(listExit.value, provider);
    if (conflict) {
      return sendJson(res, 409, {
        error: "already_connected",
        provider,
        mailbox: conflict.shopDomain,
      });
    }
  }
  const grant = signInstallGrant(
    cfg.stateSigningKey,
    { tenantId: auth.tenantId, provider },
    Date.now() + INSTALL_GRANT_TTL_MS,
  );
  const apiOrigin = new URL(cfg.shopify.callbackUrl).origin;
  const path =
    provider === "shopify"
      ? "/shopify/install"
      : provider === "outlook"
        ? "/microsoft/install"
        : "/google/install";
  const url = `${apiOrigin}${path}?grant=${encodeURIComponent(grant)}`;
  return sendJson(res, 200, { url });
};

// POST /dashboard/connections/imap — connect a generic IMAP/SMTP mailbox.
// Unlike the OAuth connectors there's no redirect: the merchant submits
// host/port/security + an app password, we connectivity-check both IMAP and
// SMTP, then persist. Authorization is the dashboard session (→ tenant).
const handleDashboardConnectImap = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  opsFactory: (config: ImapSmtpConfig) => ImapSmtpOps = makeImapSmtpOps,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  const parsed = parseImapConnectBody(parseJsonBody(req));
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  const { config, mailbox } = parsed.value;

  // One IMAP mailbox per store: replies resolve credentials per (tenant,
  // provider), so a second active mailbox could send from the wrong account.
  // Re-connecting the SAME mailbox stays allowed (upsert — password rotation,
  // host changes). The merchant must disconnect before switching mailboxes.
  const listExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(auth.tenantId));
      }),
      layer,
    ),
  );
  if (listExit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(listExit.cause),
    });
  }
  const conflicting = listExit.value.find(
    (c) =>
      c.provider === "imap" &&
      c.status === "active" &&
      c.shopDomain.toLowerCase() !== mailbox.toLowerCase(),
  );
  if (conflicting) {
    return sendJson(res, 409, {
      error: "imap_already_connected",
      mailbox: conflicting.shopDomain,
    });
  }

  // Fail closed if we can't actually log in — better a 400 now than a
  // silently-dead connector that only errors when the agent tries to reply.
  try {
    await opsFactory(config).verify();
  } catch (cause) {
    return sendJson(res, 400, {
      error: "imap_connect_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const putExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(auth.tenantId),
          provider: "imap",
          shopDomain: mailbox,
          accessToken: config.password,
          refreshToken: null,
          tokenExpiresAt: null,
          scopes: [],
          metadata: imapConnectionMetadata(config),
        });
      }),
      layer,
    ),
  );
  if (putExit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(putExit.cause),
    });
  }
  return sendJson(res, 200, { ok: true, provider: "imap", mailbox });
};

// Live IO for IMAP/SMTP autodiscovery. The only HTTP target is the fixed,
// trusted ISPDB host (the merchant-controlled domain is hostname-validated
// before interpolation, see imap-discovery.ts) and the DNS legs return data
// we never connect to here — discovered hosts come back as form prefill and
// get the same verify-before-save treatment as merchant-typed ones.
const liveDiscoveryIo: DiscoveryIo = {
  fetchText: async (url) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4_000),
        headers: { accept: "text/xml,application/xml" },
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  },
  resolveMx: (domain) => dnsResolveMx(domain),
  hostExists: async (host) => {
    try {
      return (await dnsLookup(host, { all: true })).length > 0;
    } catch {
      return false;
    }
  },
};

// POST /dashboard/connections/imap/discover — find a mailbox's server
// settings from just the address, so the connect form can hide the
// host/port fields from non-technical merchants. Read-only (nothing is
// persisted), hence no legal-acceptance gate; authorization is the
// dashboard session.
const handleDashboardImapDiscover = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  io: DiscoveryIo = liveDiscoveryIo,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const email = parseJsonBody(req)["email"];
  if (typeof email !== "string" || email.trim().length === 0) {
    return sendJson(res, 400, { error: "missing_email" });
  }
  return sendJson(res, 200, await discoverImapSettings(email.trim(), io));
};

// POST /dashboard/connections/:provider/disconnect — revoke a connector.
const handleDashboardDisconnect = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { provider } = req.params as { provider: string };
  if (!isDisconnectProvider(provider)) {
    return sendJson(res, 400, { error: "bad_provider" });
  }
  const outcome = await Effect.runPromise(
    Effect.provide(
      revokeConnectorProviderGrants(
        TenantId(auth.tenantId),
        provider,
        auth.tenantId,
      ),
      layer,
    ),
  );
  return sendJson(res, 200, outcome);
};

// POST /dashboard/connections/telegram — mint a signed Telegram linking
// deep link for the AUTHENTICATED tenant. No credentials change hands
// here: the merchant taps the t.me link, presses Start, and the bot
// webhook binds their chat via the signed token (never a raw tenant id).
const handleDashboardConnectTelegram = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!(await tenantHasCurrentLegalAcceptance(auth.tenantId, layer))) {
    return sendLegalAcceptanceRequired(res);
  }
  if (!cfg.telegram) {
    return sendJson(res, 503, { error: "telegram_not_configured" });
  }
  const expiresAtMs = Date.now() + TELEGRAM_LINK_TTL_MS;
  const token = mintTelegramLinkToken(
    cfg.stateSigningKey,
    auth.tenantId,
    expiresAtMs,
  );
  return sendJson(res, 200, {
    url: `https://t.me/${cfg.telegram.botUsername}?start=${token}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
};

// ============================================================
// Request helpers
// ============================================================

const readQuery = (
  req: FastifyRequest,
): { url: URL; params: Record<string, string> } => {
  // The Host header is trusted only for *parsing* the path — we never echo
  // it back to the client. For URL construction we use a placeholder that
  // makes `new URL(...)` happy.
  const u = new URL(req.url ?? "/", "http://placeholder");
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  return { url: u, params };
};

const parseCookies = (raw: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
};

const SHOPIFY_INSTALL_COOKIE = "support_agent_shopify_install";

const shopifyInstallCookie = (state: string, secure: boolean): string =>
  `${SHOPIFY_INSTALL_COOKIE}=${encodeURIComponent(state)}; Path=/shopify/install; Max-Age=600; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;

const clearShopifyInstallCookie = (secure: boolean): string =>
  `${SHOPIFY_INSTALL_COOKIE}=; Path=/shopify/install; Max-Age=0; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;

// ============================================================
// Route handlers
// ============================================================

/**
 * GET /shopify/install?tenant=<uuid>
 * GET /shopify/install?shop=<shop>.myshopify.com&tenant=<uuid>
 *
 * Starts the Shopify install flow. Dashboard clicks omit `shop`: we stash the
 * tenant id in a short-lived signed cookie and send the merchant to Shopify's
 * central Admin install URL so Shopify can show the store picker. Shopify then
 * returns to this same route with a signed `shop`, where we continue through
 * the authorization-code grant and sign the tenant into OAuth `state`.
 */
// ============================================================
// Shopify app credential resolution (pilot custom distribution)
// ============================================================
//
// Pilot tenants each get their own operator-provisioned Shopify custom app
// (see ShopifyAppProvisioningStore). The presence of a provisioning row is
// the pilot-vs-SaaS switch: a tenant with a row uses its own client_id /
// client_secret; a tenant without one falls back to the deployment-wide app.
// `cfg.shopify` is always present today, so SaaS tenants resolve to exactly
// the same credentials as before this slice.

/** The deployment-wide Shopify app (SaaS path), or null in a pure-pilot
 * deployment that ships no global app (audit A6). */
const globalShopifyApp = (cfg: ApiConfig): GlobalShopifyApp | null =>
  cfg.shopify.clientId && cfg.shopify.clientSecret
    ? {
        clientId: cfg.shopify.clientId,
        clientSecret: cfg.shopify.clientSecret,
      }
    : null;

/**
 * Resolve the Shopify app credentials for a known tenant (install + callback,
 * where the merchant-initiated flow carries the tenant). Returns null only
 * when neither a per-tenant row nor a global app exists.
 */
type ResolveTenantAppOutcome =
  | {
      readonly kind: "ok";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  // Pilot gate refused the install: no non-revoked provisioning row. A4 of the
  // pre-onboarding audit — the gate is enforced HERE, authoritatively, not
  // just on the dashboard overview. `reason` distinguishes "operator never
  // provisioned" from "operator revoked it".
  | { readonly kind: "provisioning_required"; readonly reason: string }
  // No app exists anywhere (no per-tenant row, no global env app).
  | { readonly kind: "not_configured" };

const resolveTenantShopifyApp = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  tenantId: string,
): Promise<ResolveTenantAppOutcome> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      resolveShopifyAppForTenant(TenantId(tenantId), globalShopifyApp(cfg), {
        requireProvisioning: cfg.shopifyConnectRequiresProvisioning,
      }),
      layer,
    ),
  );
  if (exit._tag === "Success") {
    return {
      kind: "ok",
      clientId: exit.value.clientId,
      clientSecret: exit.value.clientSecret,
    };
  }
  const error = Cause.failureOption(exit.cause);
  if (
    error._tag === "Some" &&
    error.value._tag === "ShopifyProvisioningRequired"
  ) {
    return { kind: "provisioning_required", reason: error.value.reason };
  }
  return { kind: "not_configured" };
};

/**
 * Map a non-ok {@link ResolveTenantAppOutcome} to an HTTP response. A pilot
 * gate refusal is a 403 (the operator must provision/re-provision the app),
 * distinct from a 500 "no app exists anywhere" misconfiguration.
 */
const sendShopifyAppResolveError = (
  res: FastifyReply,
  outcome: Exclude<ResolveTenantAppOutcome, { kind: "ok" }>,
): void => {
  if (outcome.kind === "provisioning_required") {
    sendJson(res, 403, {
      error: "shopify_provisioning_required",
      reason: outcome.reason,
    });
    return;
  }
  sendJson(res, 500, { error: "shopify_app_not_configured" });
};

/**
 * Resolve the Shopify app secret for a shop domain (webhooks). The shop
 * header is an unauthenticated routing hint; the resolved secret is what
 * actually authenticates the request via HMAC. Returns null when the shop
 * matches no app (no row + no global) — the caller then cannot verify and
 * must reject.
 */
const resolveShopWebhookSecret = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  shop: string,
): Promise<string | null> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(resolveShopifyAppForShop(shop, globalShopifyApp(cfg)), layer),
  );
  return exit._tag === "Success" ? exit.value.clientSecret : null;
};

/**
 * The store domain the operator recorded at provisioning (A4), or null. When
 * present, the install flow targets that shop's standard OAuth authorize URL
 * directly instead of the unverified managed-install store picker.
 */
const resolveProvisionedShop = async (
  layer: ApiLayer,
  tenantId: string,
): Promise<string | null> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        const row = yield* store.get(TenantId(tenantId));
        return row?.shopDomain ?? null;
      }),
      layer,
    ),
  );
  return exit._tag === "Success" ? exit.value : null;
};

const handleShopifyInstall = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const { params } = readQuery(req);
  const shopParam = params["shop"];
  const shop = shopParam ? normalizeShopDomain(shopParam) : null;
  // The dashboard-initiated install carries a SIGNED grant (minted by the
  // authenticated /dashboard/connect endpoint), not a raw tenant id — so an
  // attacker can't start an install that binds their store to a victim tenant
  // (5th-audit #2). A raw `?tenant=` is no longer accepted. The Shopify-
  // initiated path (no grant, has `hmac`) is unchanged below.
  let tenant: string | undefined;
  const grantParam = params["grant"];
  if (grantParam) {
    const grant = verifyInstallGrant(cfg.stateSigningKey, grantParam);
    if (!grant || grant.provider !== "shopify") {
      sendJson(res, 401, { error: "invalid_install_grant" });
      return;
    }
    tenant = grant.tenantId;
  }
  if (shopParam && !shop) {
    sendJson(res, 400, { error: "missing_or_invalid_shop" });
    return;
  }
  if (!shop) {
    if (!tenant) {
      sendJson(res, 400, { error: "missing_tenant" });
      return;
    }
    if (!(await tenantHasCurrentLegalAcceptance(tenant, layer))) {
      sendLegalAcceptanceRequired(res);
      return;
    }
    const app = await resolveTenantShopifyApp(cfg, layer, tenant);
    if (app.kind !== "ok") {
      sendShopifyAppResolveError(res, app);
      return;
    }
    // A4: if the operator recorded the store at provisioning, go straight to
    // that shop's standard OAuth authorize URL (proven) instead of the
    // unverified managed-install store picker.
    const provisionedShop = await resolveProvisionedShop(layer, tenant);
    const state = signState(cfg.stateSigningKey, tenant);
    if (provisionedShop) {
      const installUrl = buildInstallUrl({
        shop: provisionedShop,
        clientId: app.clientId,
        redirectUri: cfg.shopify.callbackUrl,
        state,
      });
      sendRedirectWithHeaders(res, installUrl, {
        "Set-Cookie": clearShopifyInstallCookie(
          cfg.shopify.callbackUrl.startsWith("https://"),
        ),
      });
      return;
    }
    // F1: in pilot mode the managed-install store picker is non-functional —
    // its re-entry verifies the HMAC with the global app secret, which
    // pure-pilot mode forbids, so it dead-ends at 400. New provisioning
    // requires a shop (see handleAdminShopifyAppPut), so this only fires for a
    // legacy shop-less row: refuse with the same operator-action family as the
    // other provisioning gates rather than redirect to a dead end.
    if (cfg.shopifyConnectRequiresProvisioning) {
      sendJson(res, 403, {
        error: "shopify_provisioning_required",
        reason: "shop_not_recorded",
      });
      return;
    }
    const managedInstallUrl = buildManagedInstallUrl({
      clientId: app.clientId,
    });
    sendRedirectWithHeaders(res, managedInstallUrl, {
      "Set-Cookie": shopifyInstallCookie(
        state,
        cfg.shopify.callbackUrl.startsWith("https://"),
      ),
    });
    return;
  }

  if (!tenant) {
    const hmac = params["hmac"];
    if (!hmac) {
      sendJson(res, 400, { error: "missing_tenant" });
      return;
    }
    // This `!tenant` entry is the Shopify-/SaaS-initiated install (the
    // merchant hit a global-app install link, no tenant in hand yet), so the
    // HMAC is verified with the deployment-wide secret. The pilot flow always
    // carries `?tenant=` and goes through the branch below; the final install
    // URL re-resolves the now-known tenant's client_id either way.
    // A pure-pilot deployment ships no global app (audit A6), so this
    // global-initiated path can't be authenticated — refuse it.
    if (!cfg.shopify.clientSecret) {
      sendJson(res, 400, { error: "missing_tenant" });
      return;
    }
    const hmacOk = verifyCallbackHmac({
      clientSecret: cfg.shopify.clientSecret,
      query: params,
      receivedHmac: hmac,
    });
    if (!hmacOk) {
      sendJson(res, 401, { error: "hmac_verification_failed" });
      return;
    }

    const pending = parseCookies(req.headers.cookie)[SHOPIFY_INSTALL_COOKIE];
    if (pending) {
      const decoded = verifyState(cfg.stateSigningKey, pending);
      if (decoded) tenant = decoded.tenantId;
    }

    if (!tenant) {
      const resolveExit = await Effect.runPromiseExit(
        Effect.provide(findTenantByShop(shop), layer),
      );
      if (resolveExit._tag !== "Success") {
        sendJson(res, 500, {
          error: "tenant_resolve_failed",
          detail: opaqueCause(resolveExit.cause),
        });
        return;
      }
      if (!resolveExit.value) {
        sendLegalAcceptanceRequired(res);
        return;
      }
      tenant = resolveExit.value;
    }
  } else {
    if (!(await tenantHasCurrentLegalAcceptance(tenant, layer))) {
      sendLegalAcceptanceRequired(res);
      return;
    }
    const ownership = await Effect.runPromise(
      Effect.provide(
        Effect.either(assertShopifyShopConnectable(shop, tenant)),
        layer,
      ),
    );
    if (ownership._tag === "Left") {
      if (ownership.left instanceof ShopifyShopAlreadyConnected) {
        sendJson(res, 409, {
          error: "shop_already_connected",
          shop,
        });
        return;
      }
      sendJson(res, 500, {
        error: "shop_ownership_check_failed",
        detail: ownership.left.message,
      });
      return;
    }
  }

  if (!(await tenantHasCurrentLegalAcceptance(tenant, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }

  const app = await resolveTenantShopifyApp(cfg, layer, tenant);
  if (app.kind !== "ok") {
    sendShopifyAppResolveError(res, app);
    return;
  }
  const state = signState(cfg.stateSigningKey, tenant);
  const installUrl = buildInstallUrl({
    shop,
    clientId: app.clientId,
    redirectUri: cfg.shopify.callbackUrl,
    state,
  });
  sendRedirectWithHeaders(res, installUrl, {
    "Set-Cookie": clearShopifyInstallCookie(
      cfg.shopify.callbackUrl.startsWith("https://"),
    ),
  });
};

/**
 * GET /shopify/auth/callback?code&hmac&shop[&state][&host&timestamp]
 *
 * Two install paths funnel through here:
 *
 *   1. Dashboard-initiated — merchant first hit `/shopify/install?tenant=...`,
 *      we signed `tenant` into `state`, Shopify echoed it back. We recover
 *      the tenantId from the signed state.
 *
 *   2. Shopify Custom Distribution — merchant clicked a Partner Dashboard
 *      install link. Shopify drove the OAuth flow directly, so we don't
 *      see the merchant before the callback and there's no `state` of our
 *      design. We only continue when the shop is already linked to a tenant
 *      that accepted the current legal terms; this avoids writing connector
 *      credentials before DPA acceptance.
 *
 * HMAC is always verified. If `state` is present but doesn't verify, we
 * reject with 401 (tampered) — we never silently fall back to shop
 * resolution in that case.
 */
const handleShopifyCallback = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const { params } = readQuery(req);
  const shop = params["shop"];
  const code = params["code"];
  const state = params["state"];
  const hmac = params["hmac"];

  // Shopify sometimes redirects the merchant back to redirect_uri with an
  // `error=...&error_description=...` instead of `code` (e.g. the merchant
  // clicked "Cancel" on the consent screen, or the app version is missing
  // a required field). Surface that directly so the caller can debug
  // instead of getting a generic "missing_required_param".
  if (params["error"]) {
    sendJson(res, 400, {
      error: "shopify_oauth_error",
      shopifyError: params["error"],
      shopifyErrorDescription: params["error_description"] ?? null,
    });
    return;
  }

  if (!shop || !isValidShopDomain(shop)) {
    sendJson(res, 400, { error: "invalid_shop", shop: shop ?? null });
    return;
  }
  if (!code || !hmac) {
    const missing: Array<string> = [];
    if (!code) missing.push("code");
    if (!hmac) missing.push("hmac");
    sendJson(res, 400, {
      error: "missing_required_param",
      missing,
      // Echo the keys we DID see (not the values — those may include the
      // shop's `host` token which is sensitive-ish). Helps tell apart "I
      // hit the callback URL by hand" (empty) from "Shopify called us
      // weirdly" (has `shop`, `host`, `timestamp` but no `code`).
      receivedParamNames: Object.keys(params).sort(),
    });
    return;
  }
  // Resolve the tenant BEFORE verifying the HMAC. In pilot custom
  // distribution each tenant's callback is signed with its own app secret,
  // so we need the tenant — and thus its app credentials — in hand first.
  // The tenant comes from our own signed `state` (verifiable without
  // Shopify's secret); custom-distribution direct installs with no state of
  // our design fall back to shop resolution.
  let tenantId: string | null = null;
  if (state) {
    const decoded = verifyState(cfg.stateSigningKey, state);
    if (!decoded) {
      sendJson(res, 401, { error: "state_verification_failed" });
      return;
    }
    tenantId = decoded.tenantId;
  }

  if (!tenantId) {
    const resolveExit = await Effect.runPromiseExit(
      Effect.provide(findTenantByShop(shop), layer),
    );
    if (resolveExit._tag !== "Success") {
      sendJson(res, 500, {
        error: "tenant_resolve_failed",
        detail: opaqueCause(resolveExit.cause),
      });
      return;
    }
    if (!resolveExit.value) {
      sendLegalAcceptanceRequired(res);
      return;
    }
    tenantId = resolveExit.value;
  }

  const app = await resolveTenantShopifyApp(cfg, layer, tenantId);
  if (app.kind !== "ok") {
    sendShopifyAppResolveError(res, app);
    return;
  }

  const hmacOk = verifyCallbackHmac({
    clientSecret: app.clientSecret,
    query: params,
    receivedHmac: hmac,
  });
  if (!hmacOk) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return;
  }

  // Enforce the provisioned shop (5th-audit #5): if the operator recorded a
  // store at provisioning, the callback MUST be for that exact shop. The
  // tenant's app can be installed on more than one store (all signing with the
  // same secret, so HMAC passes), and a signed state could otherwise complete
  // OAuth for a DIFFERENT shop and overwrite the recorded shop. Refuse the
  // mismatch instead of silently re-binding.
  const provisionedShop = await resolveProvisionedShop(layer, tenantId);
  if (provisionedShop && provisionedShop !== shop) {
    sendJson(res, 409, {
      error: "shop_mismatch",
      expected: provisionedShop,
      got: shop,
    });
    return;
  }

  if (!(await tenantHasCurrentLegalAcceptance(tenantId, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }

  let token: { accessToken: string; scope: ReadonlyArray<string> };
  try {
    token = await exchangeCodeForToken({
      shop,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code,
    });
  } catch (cause) {
    sendJson(res, 502, {
      error: "token_exchange_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  const appUninstalledWebhook = await registerAppUninstalledWebhook({
    shop,
    accessToken: token.accessToken,
    apiVersion: cfg.shopify.apiVersion,
    webhookUrl: appUninstalledWebhookUrl(cfg.shopify.callbackUrl),
  }).catch((cause) => {
    sendJson(res, 502, {
      error: "webhook_registration_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  });
  if (!appUninstalledWebhook) return;

  const persistResult = await Effect.runPromise(
    Effect.provide(
      Effect.either(
        Effect.gen(function* () {
          const tx = yield* TransactionRunner;
          return yield* tx.run(
            Effect.gen(function* () {
              const ownership = yield* claimShopifyShopForTenant(
                shop,
                tenantId,
              );
              const store = yield* ConnectorCredentialStore;
              yield* store.put({
                tenantId: TenantId(tenantId),
                provider: "shopify",
                shopDomain: shop,
                accessToken: token.accessToken,
                scopes: token.scope,
                apiVersion: cfg.shopify.apiVersion,
                metadata: {
                  shopifyWebhooks: {
                    appUninstalled: {
                      id: appUninstalledWebhook.id,
                      uri: appUninstalledWebhook.uri,
                      status: appUninstalledWebhook.status,
                      registeredAt: new Date().toISOString(),
                    },
                  },
                },
              });
              // Learn the connected shop on the pilot provisioning row and
              // flip it to `connected`. No-op for SaaS tenants (no row).
              const provisioning = yield* ShopifyAppProvisioningStore;
              yield* provisioning.markConnected(TenantId(tenantId), shop);
              return { ownership };
            }),
          );
        }),
      ),
      layer,
    ),
  );

  if (persistResult._tag === "Left") {
    if (persistResult.left instanceof ShopifyShopAlreadyConnected) {
      sendJson(res, 409, {
        error: "shop_already_connected",
        shop,
      });
      return;
    }
    if (persistResult.left instanceof ShopifyInstallTenantNotFound) {
      sendJson(res, 404, {
        error: "tenant_not_found",
        tenantId,
      });
      return;
    }
    sendJson(res, 500, {
      error: "persist_failed",
      detail:
        persistResult.left instanceof Error
          ? persistResult.left.message
          : String(persistResult.left),
    });
    return;
  }

  // Best-effort: kick off the shop-policy import so the tenant's knowledge base
  // is seeded with their shipping + refund policies. Off the request path (a
  // pg-boss job) and fully swallowed — a publish failure must never turn a
  // successful connect into an error.
  try {
    await shopifyPolicyImportPublisher(cfg.databaseUrl)({ tenantId });
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shopify-policy-import] enqueue failed for tenant=${tenantId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  // Install succeeded. JSON callers (tests, curl with
  // `Accept: application/json`) get a structured success body so
  // assertions don't have to follow redirects.
  const acceptsJson = (req.headers["accept"] ?? "")
    .toString()
    .toLowerCase()
    .includes("application/json");
  if (acceptsJson) {
    sendJson(res, 200, {
      ok: true,
      tenantId,
      shop,
      scopes: token.scope,
      ownershipTransferred: persistResult.right.ownership.transferred,
      appUninstalledWebhook,
    });
    return;
  }
  // Browser flow: land the merchant back in our own app (the dashboard
  // integrations page, which now shows the active connection) when a
  // dashboard origin is configured; otherwise fall back to the
  // standalone `/installed` landing page, echoing `host` + `shop` so it
  // has merchant context.
  const dashboardRedirect = dashboardConnectRedirect(
    cfg.dashboardBaseUrl,
    "shopify",
    { shop },
  );
  if (dashboardRedirect) {
    sendRedirect(res, dashboardRedirect);
    return;
  }
  const installedQs = new URLSearchParams({ shop });
  const hostParam = params["host"];
  if (hostParam) installedQs.set("host", hostParam);
  sendRedirect(res, `/installed?${installedQs.toString()}`);
};

/**
 * GET /installed?host=<base64>&shop=<shop>
 *
 * The merchant-facing landing page after a successful install. Shopify
 * also calls this URL when the merchant opens the app from their admin
 * (the "App URL" in the Partner Dashboard release). For now we serve a
 * minimal HTML "connected" page — once the dashboard exists this becomes
 * its entry point.
 *
 * This route does NOT verify HMAC: Shopify only HMAC-signs entry-point
 * calls (install + webhooks), and we redirect to this URL from our own
 * callback after persisting the token, so there's no token-bearing
 * Shopify request to verify here.
 */
/** HTML-entity escape for values interpolated into HTML pages (audit S5). */
const escapeHtml = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

// The decoded `host` param must be a plain admin.shopify.com path —
// charset-restricted so it can't break out of the href attribute even
// before escaping (audit S5).
const ADMIN_HOST_RE = /^admin\.shopify\.com\/[A-Za-z0-9./_-]*$/u;

const handleInstalledPage = (req: FastifyRequest, res: FastifyReply): void => {
  const { params } = readQuery(req);
  const shop = params["shop"] ?? null;
  const host = params["host"] ?? null;
  let adminUrl: string | null = null;
  if (host) {
    try {
      const decoded = Buffer.from(host, "base64").toString("utf8");
      adminUrl = ADMIN_HOST_RE.test(decoded) ? `https://${decoded}` : null;
    } catch {
      adminUrl = null;
    }
  }
  // Only a syntactically valid *.myshopify.com domain renders; anything
  // else (script payloads, attribute breakouts) is dropped, and the value
  // is entity-escaped on interpolation regardless (audit S5 — this was an
  // unauthenticated reflected XSS).
  const safeShop = shop && isValidShopDomain(shop) ? escapeHtml(shop) : null;
  const adminAnchor = adminUrl
    ? `<a href="${escapeHtml(adminUrl)}">return to your Shopify admin</a>`
    : "return to your Shopify admin";
  // No-op pages should be HTML so the browser renders them; the user
  // typed the URL or got bounced here from the callback.
  sendHtml(
    res,
    200,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>support-agent — connected</title>
  <style>
    body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    code { background: #f3f3f3; padding: 0.1em 0.3em; border-radius: 4px; }
    .ok { color: #1a7a3a; }
  </style>
</head>
<body>
  <h1 class="ok">Connected</h1>
  <p>${safeShop ? `Your store <code>${safeShop}</code> is connected to support-agent.` : "Your store is connected to support-agent."}</p>
  <p>You can ${adminAnchor} now. A dashboard for managing cases, agents, and approvals is on the way.</p>
</body>
</html>`,
  );
};

/**
 * POST /webhooks/shopify/app/uninstalled
 *
 * Shopify fires this webhook after a merchant uninstalls the app. The
 * shop's access token is already invalid by the time we receive it — we
 * mark our `connector_connections` row `revoked` so any subsequent
 * `shopify.*` tool call fails loudly with `ShopifyAuthMissing` instead of
 * hammering a dead token.
 *
 * Lifecycle:
 *   1. Read raw body + `X-Shopify-Hmac-Sha256` + `X-Shopify-Shop-Domain`.
 *   2. Verify HMAC over the raw bytes with `client_secret`. Bad sig → 401.
 *   3. Find the tenant linked to that shop. Unknown shop → 200 no-op.
 *   4. `revoke(tenantId, "shopify", shopDomain)`. Already-revoked or
 *      missing row → still 200 (idempotent: nothing to do).
 *   5. Return 200 once HMAC verified, regardless of downstream state.
 *      Returning a 5xx would make Shopify retry indefinitely.
 */
const handleAppUninstalled = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shopHeader = req.headers["x-shopify-shop-domain"];
  const receivedHmac = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;
  const shop = Array.isArray(shopHeader) ? shopHeader[0] : shopHeader;

  if (!receivedHmac || !shop) {
    sendJson(res, 400, { error: "missing_required_header" });
    return;
  }
  if (!isValidShopDomain(shop)) {
    sendJson(res, 400, { error: "invalid_shop", shop });
    return;
  }

  const rawBody = req.body as Buffer;

  // Resolve the per-tenant app secret from the (unauthenticated) shop header
  // before verifying — each pilot shop's webhooks are signed by its own app.
  // No match (no provisioning row + no global app) → can't verify → reject.
  const webhookSecret = await resolveShopWebhookSecret(cfg, layer, shop);
  if (!webhookSecret) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return;
  }
  const hmacOk = verifyShopifyWebhookHmac({
    clientSecret: webhookSecret,
    rawBody,
    receivedHmacB64: receivedHmac,
  });
  if (!hmacOk) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return;
  }

  // Body parse is informational only — the HMAC-verified shop header is
  // authoritative. We don't reject the request if the body is malformed
  // after a valid HMAC; Shopify wouldn't accept the 200 retry policy if
  // we did.
  parseUninstallPayload(rawBody);

  const tenantExit = await Effect.runPromiseExit(
    Effect.provide(findTenantByShop(shop), layer),
  );
  if (tenantExit._tag !== "Success") {
    sendJson(res, 500, {
      error: "tenant_lookup_failed",
      detail: opaqueCause(tenantExit.cause),
    });
    return;
  }
  const tenantId = tenantExit.value;
  if (!tenantId) {
    sendJson(res, 200, { ok: true, action: "noop_unknown_shop" });
    return;
  }

  const revokeResult = await Effect.runPromise(
    Effect.provide(
      Effect.either(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.revoke(TenantId(tenantId), "shopify", shop);
        }),
      ),
      layer,
    ),
  );

  if (revokeResult._tag === "Right") {
    sendJson(res, 200, { ok: true, action: "revoked" });
    return;
  }
  // ConnectorNotFound → idempotent no-op (the row was never written, or
  // a concurrent uninstall already collapsed it). ConnectorStoreDbError →
  // genuine infra error; we still 200 (Shopify would retry storm on 5xx)
  // but log loudly so the operator notices.
  if (revokeResult.left instanceof ConnectorNotFound) {
    sendJson(res, 200, { ok: true, action: "noop_already_gone" });
    return;
  }
  req.log.error(
    { err: revokeResult.left },
    "[webhook app/uninstalled] revoke failed",
  );
  sendJson(res, 200, { ok: true, action: "noop_revoke_failed" });
};

// ============================================================
// Shopify compliance webhooks (mandatory for App Store distribution)
// ============================================================
//
// Three webhooks Shopify requires every app to implement:
//   - customers/data_request — customer asked Shopify for their data;
//     we have 30 days to comply. Today: persist to audit_log as a
//     paper trail; ops fulfils manually.
//   - customers/redact — Shopify-mandated erasure 10 days after the
//     customer is redacted on the merchant side. We delete every case
//     (and its transitions, audit, approvals) matching the email or
//     customer id stamped at case-create time.
//   - shop/redact — 48h after a merchant uninstalls. We delete every
//     row tied to the tenant: cases, audit, approvals, connector
//     credentials, and finally the tenant row.
//
// All three share the same HMAC + raw-body pattern as
// `app/uninstalled`. The HMAC envelope authenticates `shop_domain`, so
// we treat the body as trusted once it verifies. Always 200 once HMAC
// passes — Shopify retries indefinitely on non-200, and a partial state
// is more dangerous than a 200 + log.

/**
 * Shared scaffolding for the three compliance webhooks: HMAC verify,
 * raw-body capture, tenant resolution by shop domain. Returns null on
 * any failure (handler should already have responded by then) or the
 * resolved `{ tenantId, shop, rawBody }` for the per-route logic to
 * consume.
 */
const verifyComplianceWebhook = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<{ tenantId: string | null; shop: string; rawBody: Buffer } | null> => {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const shopHeader = req.headers["x-shopify-shop-domain"];
  const receivedHmac = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;
  const shop = Array.isArray(shopHeader) ? shopHeader[0] : shopHeader;
  if (!receivedHmac || !shop) {
    sendJson(res, 400, { error: "missing_required_header" });
    return null;
  }
  if (!isValidShopDomain(shop)) {
    sendJson(res, 400, { error: "invalid_shop", shop });
    return null;
  }

  const rawBody = req.body as Buffer;

  // Per-tenant app secret resolved from the shop header before verifying —
  // pilot shops are signed by their own app (see handleAppUninstalled).
  const webhookSecret = await resolveShopWebhookSecret(cfg, layer, shop);
  if (!webhookSecret) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return null;
  }
  const hmacOk = verifyShopifyWebhookHmac({
    clientSecret: webhookSecret,
    rawBody,
    receivedHmacB64: receivedHmac,
  });
  if (!hmacOk) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return null;
  }

  const tenantExit = await Effect.runPromiseExit(
    Effect.provide(findTenantByShop(shop), layer),
  );
  if (tenantExit._tag !== "Success") {
    // 500 here would make Shopify retry; we still 200 below with a noop
    // action so the caller sees the failure path. Log loudly.
    req.log.error(
      { err: tenantExit.cause },
      "[compliance webhook] tenant lookup failed",
    );
    return { tenantId: null, shop, rawBody };
  }
  return { tenantId: tenantExit.value, shop, rawBody };
};

/** POST /webhooks/shopify/customers/data_request */
const handleCustomersDataRequest = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const verified = await verifyComplianceWebhook(cfg, layer, req, res);
  if (!verified) return;
  const payload = parseCustomersDataRequest(verified.rawBody);

  if (!verified.tenantId) {
    // No tenant for this shop — nothing to log against. Still 200 so
    // Shopify doesn't retry.
    sendJson(res, 200, { ok: true, action: "noop_unknown_shop" });
    return;
  }

  const recordExit = await Effect.runPromiseExit(
    Effect.provide(
      recordDataRequest({
        tenantId: verified.tenantId,
        shopDomain: verified.shop,
        customerEmail: payload.customer.email,
        shopifyCustomerNumericId: payload.customer.id,
        dataRequestId: payload.dataRequestId,
        ordersRequested: payload.ordersRequested,
      }),
      layer,
    ),
  );
  if (recordExit._tag !== "Success") {
    req.log.error(
      { err: recordExit.cause },
      "[webhook customers/data_request] record failed",
    );
    sendJson(res, 200, { ok: true, action: "noop_record_failed" });
    return;
  }
  sendJson(res, 200, { ok: true, action: "recorded" });
};

/** POST /webhooks/shopify/customers/redact */
const handleCustomersRedact = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const verified = await verifyComplianceWebhook(cfg, layer, req, res);
  if (!verified) return;
  const payload = parseCustomersRedact(verified.rawBody);

  if (!verified.tenantId) {
    sendJson(res, 200, { ok: true, action: "noop_unknown_shop" });
    return;
  }

  const redactExit = await Effect.runPromiseExit(
    Effect.provide(
      redactCustomer({
        tenantId: verified.tenantId,
        email: payload.customer.email,
        shopifyCustomerNumericId: payload.customer.id,
      }),
      layer,
    ),
  );
  if (redactExit._tag !== "Success") {
    req.log.error(
      { err: redactExit.cause },
      "[webhook customers/redact] redact failed",
    );
    sendJson(res, 200, { ok: true, action: "noop_redact_failed" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    action: "redacted",
    matchedCases: redactExit.value.matchedCaseIds.length,
  });
};

/** POST /webhooks/shopify/shop/redact */
const handleShopRedact = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const verified = await verifyComplianceWebhook(cfg, layer, req, res);
  if (!verified) return;
  // Payload is informational; tenant resolution already happened via
  // shop domain. Parse anyway so a malformed body surfaces in logs.
  parseShopRedact(verified.rawBody);

  if (!verified.tenantId) {
    sendJson(res, 200, { ok: true, action: "noop_unknown_shop" });
    return;
  }

  const redactExit = await Effect.runPromiseExit(
    Effect.provide(
      redactShop(verified.tenantId, {
        action: "tenant.redacted",
        actor: "shopify-compliance",
        details: { shop: verified.shop ?? null },
      }),
      layer,
    ),
  );
  if (redactExit._tag !== "Success") {
    req.log.error(
      { err: redactExit.cause },
      "[webhook shop/redact] redact failed",
    );
    sendJson(res, 200, { ok: true, action: "noop_redact_failed" });
    return;
  }
  sendJson(res, 200, { ok: true, action: "redacted", ...redactExit.value });
};

// ============================================================
// Gmail OAuth — install + callback
// ============================================================

/**
 * GET /google/install?tenant=<uuid>[&provider=gmail|google_sheets][&loginHint=<email>]
 *
 * Mirror of the Shopify install entrypoint. We sign the tenant into the
 * OAuth `state` with the Google connector kind so the shared callback can
 * recover both and reject tampered states. Unlike Shopify, Google has no
 * platform-driven install initiation — every install starts from our own
 * dashboard / link, so there's no Shopify-style HMAC fallback for a
 * tenant-less call.
 */
const handleGoogleInstall = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.google) {
    sendJson(res, 503, { error: "google_oauth_not_configured" });
    return;
  }
  const { params } = readQuery(req);
  // Require a signed install grant (minted by the authenticated
  // /dashboard/connect endpoint) — never a raw `?tenant=` (5th-audit #2).
  // The grant carries BOTH the tenant and the Google connector.
  const grantParam = params["grant"];
  if (!grantParam) {
    sendJson(res, 400, { error: "missing_install_grant" });
    return;
  }
  const grant = verifyInstallGrant(cfg.stateSigningKey, grantParam);
  if (!grant || !isGoogleOAuthProvider(grant.provider)) {
    sendJson(res, 401, { error: "invalid_install_grant" });
    return;
  }
  const tenant = grant.tenantId;
  const providerParam = grant.provider;
  if (!(await tenantHasCurrentLegalAcceptance(tenant, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }
  const state = signGoogleInstallState(cfg.stateSigningKey, {
    tenantId: tenant,
    provider: providerParam,
  });
  const loginHint = params["login_hint"] ?? params["loginHint"];
  const authorizeUrl = buildGoogleAuthorizeUrl({
    clientId: cfg.google.clientId,
    redirectUri: cfg.google.callbackUrl,
    state,
    provider: providerParam,
    ...(loginHint ? { loginHint } : {}),
  });
  sendRedirect(res, authorizeUrl);
};

/**
 * GET /google/auth/callback?code=&state=
 *
 * Order of operations:
 *   1. Verify signed state → tenantId + Google connector provider.
 *   2. Exchange code for `{ accessToken, refreshToken, expiresIn }`.
 *      Google only hands back a refresh token on first consent (we set
 *      `prompt=consent` to force it on every install).
 *   3. Fetch the OIDC `userinfo.email` so we know which Google account
 *      the tokens authorize — it becomes the `shopDomain` discriminator.
 *   4. Persist via `ConnectorCredentialStore.put`.
 *   5. For Gmail only, register a `users.watch` so Gmail starts pushing
 *      notifications to our Pub/Sub topic. Store the returned `historyId`
 *      + lease expiry in the connector's metadata blob.
 *   6. For Gmail only, backfill existing unread INBOX messages so customer
 *      replies that predate the install can resume existing cases.
 *
 * If steps 1-4 succeed but 5 fails, we still 200 — the credentials are
 * saved and a re-install (or a scheduled watch-refresh) can recover.
 * Failing the install over a flaky watch call would orphan the OAuth grant.
 */
/**
 * Shared by the OAuth callbacks: when the tenant already has an ACTIVE
 * connection for `provider` under a DIFFERENT mailbox, answer the request
 * (browser → redirect to the integrations page with the conflict spelled
 * out; otherwise JSON 409) and return `true` so the caller stops. Same-
 * mailbox re-auth returns `false` — the upsert repairs tokens in place.
 */
const rejectWhenMailboxConnected = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  opts: {
    readonly tenantId: string;
    readonly provider: OAuthMailboxProvider;
    readonly mailbox: string;
  },
): Promise<boolean> => {
  const listExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.listForTenant(TenantId(opts.tenantId));
      }),
      layer,
    ),
  );
  if (listExit._tag !== "Success") {
    sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(listExit.cause),
    });
    return true;
  }
  const conflict = activeMailboxConflict(
    listExit.value,
    opts.provider,
    opts.mailbox,
  );
  if (!conflict) return false;
  const acceptsJson = (req.headers["accept"] ?? "")
    .toString()
    .toLowerCase()
    .includes("application/json");
  const redirectUrl = alreadyConnectedRedirect(
    cfg.dashboardBaseUrl,
    opts.provider,
    conflict.shopDomain,
  );
  if (!acceptsJson && redirectUrl) {
    sendRedirect(res, redirectUrl);
  } else {
    sendJson(res, 409, {
      error: "already_connected",
      provider: opts.provider,
      mailbox: conflict.shopDomain,
    });
  }
  return true;
};

const handleGoogleCallback = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.google) {
    sendJson(res, 503, { error: "google_oauth_not_configured" });
    return;
  }
  const { params } = readQuery(req);
  // Best-effort provider for failure redirects: the state (when present
  // and valid) says whether this was a gmail or sheets install.
  const providerHint = (() => {
    const s = params["state"];
    if (!s) return "gmail";
    return (
      verifyGoogleInstallState(cfg.stateSigningKey, s)?.provider ?? "gmail"
    );
  })();
  // Send the merchant back to the integrations page with a renderable
  // error instead of a raw JSON dead end (audit U6); JSON remains the
  // fallback when no dashboard origin is configured.
  const failRedirect = (errCode: string): boolean => {
    const target = dashboardConnectErrorRedirect(
      cfg.dashboardBaseUrl,
      providerHint,
      errCode,
    );
    if (!target) return false;
    sendRedirect(res, target);
    return true;
  };
  if (params["error"]) {
    if (failRedirect("access_denied")) return;
    sendJson(res, 400, {
      error: "google_oauth_error",
      googleError: params["error"],
      googleErrorDescription: params["error_description"] ?? null,
    });
    return;
  }
  const code = params["code"];
  const state = params["state"];
  if (!code || !state) {
    sendJson(res, 400, { error: "missing_required_param" });
    return;
  }
  const decoded =
    verifyGoogleInstallState(cfg.stateSigningKey, state) ??
    (() => {
      // Backwards-compatible with Gmail installs that were already in
      // progress before Google state started carrying the provider.
      const legacy = verifyState(cfg.stateSigningKey, state);
      return legacy
        ? {
            tenantId: legacy.tenantId,
            provider: "gmail" as GoogleOAuthProvider,
            nonce: legacy.nonce,
          }
        : null;
    })();
  if (!decoded) {
    if (failRedirect("state_mismatch")) return;
    sendJson(res, 401, { error: "state_verification_failed" });
    return;
  }
  const tenantId = decoded.tenantId;
  const provider = decoded.provider;

  if (!(await tenantHasCurrentLegalAcceptance(tenantId, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }

  let token;
  try {
    token = await exchangeCodeForGoogleToken({
      clientId: cfg.google.clientId,
      clientSecret: cfg.google.clientSecret,
      redirectUri: cfg.google.callbackUrl,
      code,
    });
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("[google callback] token exchange failed:", cause);
    if (failRedirect("exchange_failed")) return;
    sendJson(res, 502, {
      error: "token_exchange_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  if (!token.refreshToken) {
    // We *always* set prompt=consent, so the only realistic way to get here
    // is the merchant revoking and re-granting in the same browser session
    // — Google then declines to re-issue. Surface explicitly instead of
    // persisting a connection we can't keep alive past one hour.
    sendJson(res, 400, {
      error: "missing_refresh_token",
      hint: "Re-run the install; if it persists, revoke the prior grant at https://myaccount.google.com/permissions",
    });
    return;
  }

  let email: string;
  try {
    email = await fetchGoogleUserEmail({ accessToken: token.accessToken });
  } catch (cause) {
    sendJson(res, 502, {
      error: "userinfo_fetch_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  // One Gmail mailbox per store (google_sheets is not a mailbox — exempt).
  if (
    provider === "gmail" &&
    (await rejectWhenMailboxConnected(cfg, layer, req, res, {
      tenantId,
      provider: "gmail",
      mailbox: email,
    }))
  ) {
    return;
  }

  const expiresAt = new Date(Date.now() + token.expiresInSeconds * 1000);
  const putExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(tenantId),
          provider,
          shopDomain: email,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenExpiresAt: expiresAt,
          scopes: token.scope,
        });
      }),
      layer,
    ),
  );
  if (putExit._tag !== "Success") {
    sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(putExit.cause),
    });
    return;
  }

  // Register the Gmail watch. Soft-fails by design — see the comment on
  // this route. A re-install or operator-driven re-registration recovers.
  let watch: { historyId: string; expiresAt: Date } | null = null;
  if (provider === "gmail" && cfg.google.pubsubTopic) {
    try {
      watch = await startGmailWatch({
        accessToken: token.accessToken,
        topicName: cfg.google.pubsubTopic,
      });
    } catch (cause) {
      req.log.error({ err: cause }, "[google callback] watch registration failed");
    }
  }

  if (provider === "gmail" && watch) {
    const patchExit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.patchMetadata({
            tenantId: TenantId(tenantId),
            provider,
            shopDomain: email,
            metadata: {
              historyId: watch.historyId,
              watchExpiresAt: watch.expiresAt.toISOString(),
            },
          });
        }),
        layer,
      ),
    );
    if (patchExit._tag !== "Success") {
      req.log.error(
        { err: patchExit.cause },
        "[google callback] metadata patch failed",
      );
    }
  }

  let unreadBackfill:
    | Awaited<ReturnType<typeof backfillUnreadGmailInbox>>
    | null = null;
  if (provider === "gmail") {
    try {
      unreadBackfill = await backfillUnreadGmailInbox({
        tenantId,
        mailbox: email,
        layer,
      });
    } catch (cause) {
      req.log.error({ err: cause }, "[google callback] unread backfill failed");
    }
  }

  const acceptsJson = (req.headers["accept"] ?? "")
    .toString()
    .toLowerCase()
    .includes("application/json");
  if (acceptsJson) {
    sendJson(res, 200, {
      ok: true,
      tenantId,
      provider,
      email,
      scopes: token.scope,
      watchRegistered: !!watch,
      unreadBackfill,
    });
    return;
  }
  // Same as the Shopify callback: prefer landing the merchant back on
  // the dashboard integrations page when configured.
  const dashboardRedirect = dashboardConnectRedirect(cfg.dashboardBaseUrl, provider);
  if (dashboardRedirect) {
    sendRedirect(res, dashboardRedirect);
    return;
  }
  const installedQs = new URLSearchParams({ email, provider });
  sendRedirect(res, `/installed?${installedQs.toString()}`);
};

/**
 * GET /microsoft/install?grant=<signed-grant>
 *
 * Mirror of `/google/install` for the Outlook / O365 connector. Requires a
 * signed install grant (minted by the authenticated /dashboard/connect
 * endpoint) scoped to `outlook`; never a raw `?tenant=`.
 */
const handleMicrosoftInstall = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.microsoft) {
    sendJson(res, 503, { error: "microsoft_oauth_not_configured" });
    return;
  }
  const { params } = readQuery(req);
  const grantParam = params["grant"];
  if (!grantParam) {
    sendJson(res, 400, { error: "missing_install_grant" });
    return;
  }
  const grant = verifyInstallGrant(cfg.stateSigningKey, grantParam);
  if (!grant || grant.provider !== "outlook") {
    sendJson(res, 401, { error: "invalid_install_grant" });
    return;
  }
  const tenant = grant.tenantId;
  if (!(await tenantHasCurrentLegalAcceptance(tenant, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }
  const state = signMicrosoftInstallState(cfg.stateSigningKey, {
    tenantId: tenant,
  });
  const loginHint = params["login_hint"] ?? params["loginHint"];
  const authorizeUrl = buildMicrosoftAuthorizeUrl({
    clientId: cfg.microsoft.clientId,
    redirectUri: cfg.microsoft.callbackUrl,
    state,
    tenant: cfg.microsoft.tenant,
    ...(loginHint ? { loginHint } : {}),
  });
  sendRedirect(res, authorizeUrl);
};

/**
 * GET /microsoft/auth/callback?code=&state=
 *
 * Verify state → exchange code → resolve the mailbox address via Graph `/me`
 * → persist the connection under provider `outlook`. The inbound Graph
 * subscription is created in the webhook slice (Graph validates the
 * notification URL at subscription time, so it can't be created until that
 * endpoint exists). Outbound + thread reads work as soon as this completes.
 */
const handleMicrosoftCallback = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.microsoft) {
    sendJson(res, 503, { error: "microsoft_oauth_not_configured" });
    return;
  }
  const { params } = readQuery(req);
  // Renderable failure redirect to the integrations page (audit U6);
  // JSON stays the fallback without a configured dashboard origin.
  const failRedirect = (errCode: string): boolean => {
    const target = dashboardConnectErrorRedirect(
      cfg.dashboardBaseUrl,
      "outlook",
      errCode,
    );
    if (!target) return false;
    sendRedirect(res, target);
    return true;
  };
  if (params["error"]) {
    if (failRedirect("access_denied")) return;
    sendJson(res, 400, {
      error: "microsoft_oauth_error",
      microsoftError: params["error"],
      microsoftErrorDescription: params["error_description"] ?? null,
    });
    return;
  }
  const code = params["code"];
  const state = params["state"];
  if (!code || !state) {
    sendJson(res, 400, { error: "missing_required_param" });
    return;
  }
  const decoded = verifyMicrosoftInstallState(cfg.stateSigningKey, state);
  if (!decoded) {
    if (failRedirect("state_mismatch")) return;
    sendJson(res, 401, { error: "state_verification_failed" });
    return;
  }
  const tenantId = decoded.tenantId;
  if (!(await tenantHasCurrentLegalAcceptance(tenantId, layer))) {
    sendLegalAcceptanceRequired(res);
    return;
  }

  let token;
  try {
    token = await exchangeCodeForMicrosoftToken({
      clientId: cfg.microsoft.clientId,
      clientSecret: cfg.microsoft.clientSecret,
      redirectUri: cfg.microsoft.callbackUrl,
      tenant: cfg.microsoft.tenant,
      code,
    });
  } catch (cause) {
    req.log.error({ err: cause }, "[microsoft callback] token exchange failed");
    if (failRedirect("exchange_failed")) return;
    sendJson(res, 502, {
      error: "token_exchange_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  if (!token.refreshToken) {
    sendJson(res, 400, {
      error: "missing_refresh_token",
      hint: "Re-run the install and grant offline access; if it persists, remove the app at https://myaccount.microsoft.com/permissions",
    });
    return;
  }

  let email: string;
  try {
    email = await fetchMicrosoftUserEmail({ accessToken: token.accessToken });
  } catch (cause) {
    req.log.error({ err: cause }, "[microsoft callback] userinfo (/me) failed");
    sendJson(res, 502, {
      error: "userinfo_fetch_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  // One Outlook mailbox per store: a different account than the connected
  // one is rejected even here (manual installs bypass the dashboard mint
  // guard). Re-authorizing the SAME mailbox proceeds — it repairs tokens.
  if (
    await rejectWhenMailboxConnected(cfg, layer, req, res, {
      tenantId,
      provider: "outlook",
      mailbox: email,
    })
  ) {
    return;
  }

  const expiresAt = new Date(Date.now() + token.expiresInSeconds * 1000);
  const putExit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "outlook",
          shopDomain: email,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenExpiresAt: expiresAt,
          scopes: token.scope,
        });
      }),
      layer,
    ),
  );
  if (putExit._tag !== "Success") {
    sendJson(res, 500, {
      error: "persist_failed",
      detail: opaqueCause(putExit.cause),
    });
    return;
  }

  // Register the inbound Graph subscription. Soft-fails by design (like the
  // Gmail watch): the credentials are saved and the renewal cron / a
  // re-install can recover. Needs a configured public notification URL +
  // client-state secret; Graph validates the URL during creation.
  let subscription: { id: string; expirationDateTime: string } | null = null;
  if (cfg.microsoft.notificationUrl && cfg.microsoft.webhookClientState) {
    try {
      const notificationUrl = `${cfg.microsoft.notificationUrl.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}`;
      subscription = await graphCreateSubscription({
        token: token.accessToken,
        notificationUrl,
        clientState: cfg.microsoft.webhookClientState,
        expirationDateTime: new Date(
          Date.now() + GRAPH_SUBSCRIPTION_TTL_MS,
        ).toISOString(),
      });
      const patchExit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ConnectorCredentialStore;
            return yield* store.patchMetadata({
              tenantId: TenantId(tenantId),
              provider: "outlook",
              shopDomain: email,
              metadata: {
                subscriptionId: subscription!.id,
                subscriptionExpiresAt: subscription!.expirationDateTime,
              },
            });
          }),
          layer,
        ),
      );
      if (patchExit._tag !== "Success") {
        req.log.error(
          { err: patchExit.cause },
          "[microsoft callback] subscription metadata patch failed",
        );
      }
    } catch (cause) {
      req.log.error(
        { err: cause },
        "[microsoft callback] subscription registration failed",
      );
    }
  }

  const acceptsJson = (req.headers["accept"] ?? "")
    .toString()
    .toLowerCase()
    .includes("application/json");
  if (acceptsJson) {
    sendJson(res, 200, {
      ok: true,
      tenantId,
      provider: "outlook",
      email,
      scopes: token.scope,
      subscriptionRegistered: !!subscription,
    });
    return;
  }
  const dashboardRedirect = dashboardConnectRedirect(
    cfg.dashboardBaseUrl,
    "outlook",
  );
  if (dashboardRedirect) {
    sendRedirect(res, dashboardRedirect);
    return;
  }
  const installedQs = new URLSearchParams({ email, provider: "outlook" });
  sendRedirect(res, `/installed?${installedQs.toString()}`);
};

// ============================================================
// Gmail Pub/Sub push webhook
// ============================================================

/**
 * POST /webhooks/conversations/gmail?token=<shared-secret>
 * POST /webhooks/conversations/gmail/:tenantId?token=<shared-secret>
 *
 * Google's Pub/Sub push delivers JSON like:
 *   {
 *     message: { data: base64(JSON({emailAddress, historyId})), publishTime, ... },
 *     subscription: "projects/.../subscriptions/...",
 *   }
 *
 * Auth uses a shared-secret URL token. The tenant-less route is the preferred
 * multi-tenant shape: Gmail includes the watched mailbox in the Pub/Sub
 * payload, and we resolve that mailbox back to `connector_connections`.
 * The tenant path remains supported for old single-tenant subscriptions.
 *
 * Always 200 on a verified token even when downstream work fails: Pub/Sub
 * retries on 5xx and will retry-storm us if we surface flaky state. The
 * handler logs and absorbs.
 */
const handleGmailWebhook = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  if (!cfg.google) {
    sendJson(res, 503, { error: "google_oauth_not_configured" });
    return;
  }
  if (!cfg.google.pushToken) {
    sendJson(res, 503, { error: "gmail_webhook_not_configured" });
    return;
  }

  const url = req.url ?? "/";
  const pathMatch =
    /^\/webhooks\/conversations\/gmail(?:\/([^/?]+))?(?:[/?]|$)/.exec(url);
  if (!pathMatch) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let tenantId = pathMatch[1] ?? null;

  const { params } = readQuery(req);
  const presented = params["token"] ?? "";
  // Constant-time compare. Buffer lengths MUST match — bail early
  // otherwise to avoid the timingSafeEqual throw.
  const expected = cfg.google.pushToken;
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  ) {
    sendJson(res, 401, { error: "invalid_push_token" });
    return;
  }

  const rawBody = req.body as Buffer;

  if (!tenantId) {
    const payload = parseGmailPushEnvelope(rawBody);
    if (!payload) {
      req.log.warn("[gmail webhook] unparseable push envelope; dropping");
      sendJson(res, 200, { ok: true });
      return;
    }

    const tenantExit = await Effect.runPromiseExit(
      Effect.provide(findTenantByGmailMailbox(payload.emailAddress), layer),
    );
    if (tenantExit._tag !== "Success") {
      req.log.error(
        { err: tenantExit.cause },
        "[gmail webhook] tenant lookup failed",
      );
      sendJson(res, 200, { ok: true });
      return;
    }
    tenantId = tenantExit.value;
    if (!tenantId) {
      req.log.warn(
        `[gmail webhook] no active connection for mailbox=${payload.emailAddress}`,
      );
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  try {
    await handleGmailPushNotification({
      tenantId,
      rawBody,
      layer,
      google: cfg.google,
    });
  } catch (cause) {
    req.log.error({ err: cause }, "[gmail webhook] push handling failed");
  }
  // Always 200 once token verified — Pub/Sub retries on 5xx.
  sendJson(res, 200, { ok: true });
};

// ============================================================
// Microsoft Graph change-notification webhook
// ============================================================

/**
 * POST /webhooks/conversations/outlook/:tenantId
 *
 * Two shapes hit this route:
 *   1. Subscription validation — Graph POSTs `?validationToken=…` when a
 *      subscription is created; we echo the raw token back as text/plain 200.
 *   2. Change notifications — a JSON body of `{ value: [...] }`; we verify
 *      each `clientState`, fetch the message, and publish `message.received`.
 */
const handleGraphWebhook = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  // Validation handshake first — it has no body to authenticate and must be
  // answered for the subscription to be created at all.
  const query = (req.query ?? {}) as Record<string, string | undefined>;
  const validationToken = parseGraphValidationToken(query);
  if (validationToken) {
    return res.code(200).type("text/plain").send(validationToken);
  }

  if (!cfg.microsoft) {
    return sendJson(res, 503, { error: "microsoft_oauth_not_configured" });
  }
  const { tenantId } = req.params as { tenantId: string };
  if (!tenantId) {
    return sendJson(res, 400, { error: "missing_tenant" });
  }

  const rawBody = req.body as Buffer;
  const notifications = parseGraphNotifications(rawBody);
  if (notifications.length > 0) {
    try {
      await handleGraphNotification({
        tenantId,
        notifications,
        layer,
        microsoft: cfg.microsoft,
      });
    } catch (cause) {
      req.log.error({ err: cause }, "[outlook webhook] notification handling failed");
    }
  }
  // Graph retries on non-2xx; ack with 202 once we've accepted the batch.
  return res.code(202).send();
};

// ============================================================
// GET /approvals/:id/(approve|reject)?token=<signed>
// ============================================================
//
// One-click approval surface emailed to the operator. Token is HMAC-
// signed over `<approvalId>.<expiresAt>` with `cfg.approvalSigningKey`
// (same key the worker uses to sign). On success, marks the approval
// decided + publishes the matching `approval.*` workflow event so the
// worker resumes the case. Idempotent: a second click renders an
// "already decided" page.

let cachedApprovalBoss: PgBoss | null = null;
const acquireApprovalBoss = async (
  databaseUrl: string,
): Promise<PgBoss> => {
  if (cachedApprovalBoss) return cachedApprovalBoss;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue("workflow.events", {
    policy: "key_strict_fifo",
    retryLimit: 5,
    retryBackoff: true,
  });
  cachedApprovalBoss = boss;
  return boss;
};

/**
 * GET /approvals/:id/:action — verification + confirmation page ONLY.
 * Email-security scanners (Outlook SafeLinks, Mimecast, Gmail prefetch)
 * follow GET links in inbound mail; a GET that decided the approval let
 * a scanner silently approve refunds before the manager ever opened the
 * email (audit S2). The actual decision happens in the POST below.
 */
const handleApprovalConfirmPage = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): void => {
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "";
  const match = matchApprovalRoute(pathOnly);
  if (!match) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const token = extractToken(url);
  if (!token) {
    sendHtml(
      res,
      400,
      renderApprovalPage(
        { kind: "bad_token", reason: { ok: false, reason: "malformed" } },
        match.action,
      ).body,
    );
    return;
  }
  const linkCheck = verifyApprovalLink({
    approvalId: match.approvalId,
    action: match.action,
    token,
    signingKey: cfg.approvalSigningKey,
  });
  if (linkCheck.kind !== "ok") {
    const page = renderApprovalPage(linkCheck, match.action);
    sendHtml(res, page.status, page.body);
    return;
  }
  const page = renderApprovalConfirmPage({
    approvalId: match.approvalId,
    action: match.action,
    token,
  });
  sendHtml(res, page.status, page.body);
};

/**
 * Extract the token from a POST body. The server buffers every body as
 * raw bytes (webhook HMAC requirement), so the urlencoded confirm-form
 * body is parsed here. Keeping the token in the POST body (not the URL)
 * also keeps it out of request logs (audit S6).
 */
const extractTokenFromPostBody = (body: unknown): string | null => {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const params = new URLSearchParams(body.toString("utf8"));
    return params.get("token");
  } catch {
    return null;
  }
};

const handleApprovalDecision = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const url = req.url ?? "/";
  // Match the path BEFORE the query string.
  const pathOnly = url.split("?")[0] ?? "";
  const match = matchApprovalRoute(pathOnly);
  if (!match) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  // Token comes from the confirm-form's POST body; the query-string
  // fallback keeps curl/scripted flows working.
  const token = extractTokenFromPostBody(req.body) ?? extractToken(url);
  if (!token) {
    sendHtml(
      res,
      400,
      renderApprovalPage(
        { kind: "bad_token", reason: { ok: false, reason: "malformed" } },
        match.action,
      ).body,
    );
    return;
  }

  const outcome = await decideApproval({
    approvalId: match.approvalId,
    action: match.action,
    token,
    signingKey: cfg.approvalSigningKey,
    layer,
    publish: makePgBossApprovalPublisher(() =>
      acquireApprovalBoss(cfg.databaseUrl),
    ),
  });

  const page = renderApprovalPage(outcome, match.action, {
    dashboardBaseUrl: cfg.dashboardBaseUrl,
  });
  sendHtml(res, page.status, page.body);
};

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

// ============================================================
// Member RBAC — members, roles, invitations, and the per-load self session.
// Reads/writes go through the plain db store (member-rbac-store). The route
// guard enforces members.manage on every endpoint here except /me/session
// (any member). Member-write handlers auto-claim Owner for the acting user
// while the workspace is still in open mode, so configuring roles can never
// lock the admin out.
// ============================================================

/** Read a string body field (reuses strField's non-empty semantics). */
const bodyStr = (req: FastifyRequest, key: string): string | undefined =>
  strField(parseJsonBody(req), key);

// POST /dashboard/me/session — reconcile any pending invite for this user,
// then return their effective access for the active workspace. The dashboard
// calls this on every context load.
const handleDashboardMeSession = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  // Reconcile a pending invite to a VERIFIED email only. The x-user-email header
  // is untrusted (S14), so an authenticated member can't claim an invite
  // addressed to someone else by spoofing it. We resolve the email from WorkOS
  // (keyed on the verified `sub`) — and only when a pending invite actually
  // exists, so the common no-invite load makes no WorkOS call.
  const pending = await runWithDb(layer, (db) =>
    listPendingInvitations(db, auth.tenantId),
  );
  const directory = getWorkosDirectory(req);
  let verifiedEmail: string | null = null;
  if (pending.length > 0 && auth.workosUserId && directory) {
    verifiedEmail = await directory.getEmail(auth.workosUserId);
  }
  const access = await runWithDb(layer, async (db) => {
    if (verifiedEmail) {
      await reconcileInvitation(db, auth.tenantId, {
        email: verifiedEmail,
        userDecisionUuid: userId,
        ...(auth.workosUserId ? { workosUserId: auth.workosUserId } : {}),
      });
    }
    return getMemberAccess(db, auth.tenantId, userId);
  });
  return sendJson(res, 200, sessionPermissions(access));
};

// Auto-claim helper for member-write handlers — requires the acting email.
const claimOwnerIfOpen = (
  layer: ApiLayer,
  tenantId: string,
  userId: string,
  email: string,
): Promise<void> =>
  runWithDb(layer, (db) =>
    ensureActingOwnerInOpenMode(db, tenantId, userId, email),
  );

// GET /dashboard/permission-catalog — the static permission registry.
const handleDashboardPermissionCatalog = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  return sendJson(res, 200, { permissions: RBAC_PERMISSIONS });
};

// GET /dashboard/members — members + pending invitations.
const handleDashboardMembers = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const result = await runWithDb(layer, async (db) => ({
    members: await listMembers(db, auth.tenantId),
    invitations: await listPendingInvitations(db, auth.tenantId),
  }));
  return sendJson(res, 200, result);
};

// GET /dashboard/roles — roles with their grants + assigned counts.
const handleDashboardRoles = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const roleRows = await runWithDb(layer, (db) => listRoles(db, auth.tenantId));
  return sendJson(res, 200, { roles: roleRows });
};

// POST /dashboard/members/invite — persist a pending invitation. The WorkOS
// email send happens dashboard-side; the api owns the row.
const handleDashboardMemberInvite = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId || !auth.userEmail) {
    return sendJson(res, 400, { error: "missing_user" });
  }
  const invitedByUuid = auth.userId;
  const email = bodyStr(req, "email");
  const roleId = bodyStr(req, "roleId");
  if (!email || !roleId) return sendJson(res, 400, { error: "invalid_request" });
  const workosInvitationId = bodyStr(req, "workosInvitationId");
  await claimOwnerIfOpen(layer, auth.tenantId, invitedByUuid, auth.userEmail);
  const result = await runWithDb(layer, (db) =>
    createInvitation(db, auth.tenantId, {
      email,
      roleId,
      invitedByUuid,
      ...(workosInvitationId ? { workosInvitationId } : {}),
    }),
  );
  if (!result.ok) {
    const status = result.reason === "role_not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { invitationId: result.invitationId });
};

// POST /dashboard/members/:uuid/role — change a member's role.
const handleDashboardMemberRole = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { uuid } = req.params as { uuid: string };
  const roleId = bodyStr(req, "roleId");
  if (!roleId) return sendJson(res, 400, { error: "invalid_request" });
  const result = await runWithDb(layer, (db) =>
    assignMemberRole(db, auth.tenantId, uuid, roleId),
  );
  if (!result.ok) {
    const status = result.reason === "role_not_found" ? 404 : 404;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/members/:uuid/remove — remove a member's assignment.
const handleDashboardMemberRemove = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { uuid } = req.params as { uuid: string };
  const result = await runWithDb(layer, (db) =>
    removeMember(db, auth.tenantId, uuid),
  );
  if (!result.ok) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/invitations/:id/revoke — revoke a pending invitation.
const handleDashboardInvitationRevoke = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    revokeInvitation(db, auth.tenantId, id),
  );
  if (!result.ok) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles — create a new (empty) role.
const handleDashboardRoleCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId || !auth.userEmail) {
    return sendJson(res, 400, { error: "missing_user" });
  }
  const name = bodyStr(req, "name");
  if (!name) return sendJson(res, 400, { error: "invalid_request" });
  await claimOwnerIfOpen(layer, auth.tenantId, auth.userId, auth.userEmail);
  const result = await runWithDb(layer, (db) =>
    createRole(db, auth.tenantId, name),
  );
  if (!result.ok) return sendJson(res, 409, { error: result.reason });
  return sendJson(res, 200, { roleId: result.roleId });
};

// POST /dashboard/roles/:id/rename
const handleDashboardRoleRename = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const name = bodyStr(req, "name");
  if (!name) return sendJson(res, 400, { error: "invalid_request" });
  const result = await runWithDb(layer, (db) =>
    renameRole(db, auth.tenantId, id, name),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles/:id/permissions — replace a role's permission grants.
const handleDashboardRolePermissions = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const raw = parseJsonBody(req)["permissionIds"];
  const ids = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : [];
  if (ids.some((pid) => !isRbacPermissionId(pid))) {
    return sendJson(res, 400, { error: "invalid_permission" });
  }
  const result = await runWithDb(layer, (db) =>
    setRolePermissions(db, auth.tenantId, id, ids),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/roles/:id/delete
const handleDashboardRoleDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    deleteRole(db, auth.tenantId, id),
  );
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { ok: true });
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
      // approval decision) so shutdown / tests don't leak its connection.
      if (cachedApprovalBoss) {
        await cachedApprovalBoss.stop();
        cachedApprovalBoss = null;
      }
      // Drop the memoized cleanup publisher so a fresh server re-ensures
      // the queue against a new pg-boss instance.
      cachedCleanupPublisher = null;
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
