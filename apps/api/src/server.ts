import { Cause, Effect } from "effect";
import { timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  applyApprovalDecision,
  ConnectorCredentialStore,
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  decisionToEvent,
  defaultRefundPolicy,
  DEFAULT_RETENTION_DAYS,
  encrypt,
  legalAcceptanceIsCurrent,
  ShopifyAppProvisioningStore,
  TenantAgentOverridesService,
  TenantRepository,
  TransactionRunner,
  verifyShopifyWebhookHmac,
  type LLMProvider,
  type LegalAcceptance,
} from "@support-agent/services";
import {
  AgentId,
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
  auditList,
  caseContextForTenant,
  caseDetail,
  caseEvents,
  casesList,
  connectionsList,
  createTenantForOrg,
  DbClient,
  findTenantIdByWorkosOrg,
  parsePageNumber,
  parsePageSize,
  takeOverCase,
  tenantByWorkosOrg,
  tenantDeletionSnapshot,
  todaySummary,
  usageRows,
  type DrizzleDb,
} from "@support-agent/db";
import { fetchModelCatalog } from "@support-agent/providers";
import { parseAdminAuth, parseDashboardAuth } from "./dashboard-auth.js";
import { buildCatalogResponse } from "./dashboard-catalog.js";
import {
  buildModelsResponse,
  resolveActiveLlmCredential,
} from "./dashboard-llm.js";
import {
  resolveCustomerForContext,
  resolveOrderForContext,
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
import { dashboardConnectRedirect } from "./post-connect-redirect.js";
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
  type AccountCleanupJobData,
  type EncryptedConnectorGrant,
} from "./account-deletion.js";
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
  appUninstalledWebhookUrl,
  registerAppUninstalledWebhook,
} from "./shopify-webhook-registration.js";
import { startGmailWatch, revokeConnectorGrant } from "@support-agent/providers";
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
  renderApprovalPage,
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
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Shared auth for `/dashboard/*`: verify the service token, read the asserted
 * WorkOS org, resolve it to a tenant. 503 unconfigured, 401/400 bad auth,
 * 403 when the org isn't linked to a tenant.
 */
const authenticateDashboard = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
): Promise<DashboardAuthResult> => {
  if (!cfg.dashboardApiToken) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = parseDashboardAuth(
    req.headers as Record<string, string | undefined>,
    cfg.dashboardApiToken,
  );
  if (!parsed.ok) {
    return { ok: false, status: parsed.status, error: parsed.message };
  }
  const tenantId = await runWithDb(layer, (db) =>
    findTenantIdByWorkosOrg(db, parsed.organizationId),
  );
  if (!tenantId) {
    return { ok: false, status: 403, error: "no_tenant_for_organization" };
  }
  return { ok: true, tenantId, userId: parsed.userId };
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
const authenticateDashboardOrg = (
  cfg: ApiConfig,
  req: FastifyRequest,
): DashboardOrgAuthResult => {
  if (!cfg.dashboardApiToken) {
    return { ok: false, status: 503, error: "dashboard_api_not_configured" };
  }
  const parsed = parseDashboardAuth(
    req.headers as Record<string, string | undefined>,
    cfg.dashboardApiToken,
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

// GET /dashboard/cases?page=&limit= — paginated cases list.
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
        status: strField(q, "status"),
        risk: strField(q, "risk"),
        tool: strField(q, "tool"),
        agent: strField(q, "agent"),
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
      detail: String(exit.cause),
    });
  }
  const row = exit.value;
  return sendJson(res, 200, {
    requiresProvisioning: cfg.shopifyConnectRequiresProvisioning,
    provisioned: row !== null && row.status !== "revoked",
    status: row?.status ?? null,
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
    return sendJson(res, result.kind === "approval_not_found" ? 404 : 200, result);
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
): Promise<DeleteAccountResult> => {
  const snapshot = await runWithDb(layer, (db) =>
    tenantDeletionSnapshot(db, tenantId),
  );
  if (!snapshot) return { kind: "tenant_not_found" };

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
      workosOrganizationId: snapshot.workosOrganizationId,
      notificationEmail: snapshot.notificationEmail,
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
    workosOrganizationId: snapshot.workosOrganizationId,
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

// POST /dashboard/account/delete — a manager deletes their OWN tenant.
const handleDashboardAccountDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const result = await deleteTenantAccount(
    cfg,
    layer,
    auth.tenantId,
    "tenant_self",
  );
  return sendJson(res, deleteResultStatus(result), result);
};

// POST /admin/tenants/:id/delete — platform operator deletes ANY tenant.
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
  const result = await deleteTenantAccount(cfg, layer, id, "admin");
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
      detail: String(exit.cause),
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
    sendJson(res, 500, { error: "lookup_failed", detail: String(exit.cause) });
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
    sendJson(res, 500, { error: "revoke_failed", detail: String(exit.cause) });
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
    sendJson(res, 502, { error: "pcd_check_failed", detail: String(exit.cause) });
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
    sendJson(res, 500, { error: "list_failed", detail: String(exit.cause) });
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
    sendJson(res, 500, { error: "detail_failed", detail: String(exit.cause) });
    return;
  }
  if (!exit.value) {
    sendJson(res, 404, { error: "tenant_not_found" });
    return;
  }
  sendJson(res, 200, exit.value);
};

// ---- Dashboard catalog / models / tenant (reads) ----

// GET /dashboard/catalog — static agent + tool inventory (settings pages).
const handleDashboardCatalog = async (
  cfg: ApiConfig,
  _layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = authenticateDashboardOrg(cfg, req);
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

// GET /dashboard/tenant — the org's tenant (or null → dashboard sends to
// onboarding). Token + org auth; does NOT require an existing tenant.
const handleDashboardTenant = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tenant = await runWithDb(layer, (db) =>
    tenantByWorkosOrg(db, auth.organizationId),
  );
  return sendJson(res, 200, {
    tenant: tenant ? { tenantId: tenant.id, name: tenant.name } : null,
  });
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

const CONNECTOR_PROVIDERS = ["shopify", "gmail", "google_sheets"] as const;
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
  const auth = authenticateDashboardOrg(cfg, req);
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
  const grant = signInstallGrant(
    cfg.stateSigningKey,
    { tenantId: auth.tenantId, provider },
    Date.now() + INSTALL_GRANT_TTL_MS,
  );
  const apiOrigin = new URL(cfg.shopify.callbackUrl).origin;
  const path = provider === "shopify" ? "/shopify/install" : "/google/install";
  const url = `${apiOrigin}${path}?grant=${encodeURIComponent(grant)}`;
  return sendJson(res, 200, { url });
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
          detail: String(resolveExit.cause),
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
        detail: String(resolveExit.cause),
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
const handleInstalledPage = (req: FastifyRequest, res: FastifyReply): void => {
  const { params } = readQuery(req);
  const shop = params["shop"] ?? null;
  const host = params["host"] ?? null;
  let adminUrl: string | null = null;
  if (host) {
    try {
      const decoded = Buffer.from(host, "base64").toString("utf8");
      adminUrl = decoded.startsWith("admin.shopify.com/")
        ? `https://${decoded}`
        : null;
    } catch {
      adminUrl = null;
    }
  }
  const safeShop = shop && shop.length < 200 ? shop : null;
  const adminAnchor = adminUrl
    ? `<a href="${adminUrl}">return to your Shopify admin</a>`
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
      detail: String(tenantExit.cause),
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
  if (params["error"]) {
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
      detail: String(putExit.cause),
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

  const page = renderApprovalPage(outcome, match.action);
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
 * Pino logger config. Enabled by default (structured JSON); quieted to
 * `warn` under tests so the DB-gated integration suite isn't drowned in
 * per-request lines. `LOG_LEVEL` overrides the level outside tests.
 */
const loggerConfig = () =>
  process.env["NODE_ENV"] === "test"
    ? { level: "warn" }
    : { level: process.env["LOG_LEVEL"] ?? "info" };

export const startServer = async (
  cfg: ApiConfig,
): Promise<ServerHandle> => {
  const layer = buildApiLayers(cfg);

  const app: FastifyInstance = Fastify({
    logger: loggerConfig(),
    // Matches the old readRawBody cap. Shopify/Pub/Sub payloads are tiny;
    // anything near the cap is suspect and fails closed with 413.
    bodyLimit: 1024 * 1024,
  });

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

  // ---- Approval links ----
  app.get(
    "/approvals/:approvalId/:action",
    {
      schema: {
        tags: ["approvals"],
        summary: "Approve or reject a gated tool call from an emailed link",
        params: approvalParamsSchema,
        querystring: tokenQuerySchema,
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
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  dashboardGet("/dashboard/today", "Today-view rollup", handleDashboardToday);
  dashboardGet("/dashboard/cases", "Paginated cases list", handleDashboardCases);
  dashboardGet(
    "/dashboard/cases/:id",
    "Case detail with timeline + approvals",
    handleDashboardCaseDetail,
  );
  dashboardGet(
    "/dashboard/cases/:id/events",
    "New audit events for a case since ?since=",
    handleDashboardCaseEvents,
  );
  dashboardGet(
    "/dashboard/cases/:id/shopify",
    "Case-detail Shopify customer/order panels",
    handleDashboardCaseShopify,
  );
  dashboardGet(
    "/dashboard/approvals",
    "Paginated approvals list with facets",
    handleDashboardApprovals,
  );
  dashboardGet(
    "/dashboard/approvals/:id",
    "Approval detail",
    handleDashboardApprovalDetail,
  );
  dashboardGet("/dashboard/audit", "Cross-case audit log", handleDashboardAudit);
  dashboardGet(
    "/dashboard/shopify-app",
    "Shopify connect gate (pilot provisioning status)",
    handleDashboardShopifyApp,
  );
  dashboardGet(
    "/dashboard/connections",
    "Connector connections (integrations)",
    handleDashboardConnections,
  );
  dashboardGet(
    "/dashboard/usage",
    "LLM usage rows in a time window",
    handleDashboardUsage,
  );
  dashboardGet(
    "/dashboard/agent-overrides",
    "Per-agent model overrides",
    handleDashboardAgentOverrides,
  );
  dashboardGet(
    "/dashboard/catalog",
    "Agent + tool inventory",
    handleDashboardCatalog,
  );
  dashboardGet(
    "/dashboard/models",
    "Tenant LLM model catalog",
    handleDashboardModels,
  );
  dashboardGet(
    "/dashboard/tenant",
    "The org's tenant (or null → onboarding)",
    handleDashboardTenant,
  );
  dashboardGet(
    "/dashboard/settings",
    "Resolved tenant settings (refund policy + supplier sheet)",
    handleDashboardSettings,
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
  ): void => {
    app.post(
      path,
      { schema: { tags: ["dashboard"], summary } },
      async (req, res) => {
        await handler(cfg, layer, req, res);
        return res;
      },
    );
  };

  dashboardPost(
    "/dashboard/approvals/:id/approve",
    "Approve an approval (manager)",
    handleDashboardApprovalAction("approve"),
  );
  dashboardPost(
    "/dashboard/approvals/:id/reject",
    "Reject an approval (manager)",
    handleDashboardApprovalAction("reject"),
  );
  dashboardPost(
    "/dashboard/cases/:id/takeover",
    "Take over a case (manager)",
    handleDashboardTakeover,
  );
  dashboardPost(
    "/dashboard/onboarding",
    "Create a tenant for the org",
    handleDashboardOnboarding,
  );
  dashboardPost(
    "/dashboard/legal-acceptance",
    "Accept the current data processing notice + DPA",
    handleDashboardLegalAcceptance,
  );
  dashboardPost(
    "/dashboard/agents/:id/model",
    "Set a per-agent model override",
    handleDashboardAgentModelSet,
  );
  dashboardPost(
    "/dashboard/agents/:id/model/clear",
    "Clear a per-agent model override",
    handleDashboardAgentModelClear,
  );
  dashboardPost(
    "/dashboard/llm",
    "Connect a BYOK LLM credential",
    handleDashboardLlmConnect,
  );
  dashboardPost(
    "/dashboard/llm/revoke",
    "Revoke the tenant's LLM credential",
    handleDashboardLlmRevoke,
  );
  dashboardPost(
    "/dashboard/refund-policy",
    "Set the conditional refund policy",
    handleDashboardRefundPolicy,
  );
  dashboardPost(
    "/dashboard/supplier-sheet",
    "Set the supplier-escalation sheet",
    handleDashboardSupplierSheet,
  );
  dashboardPost(
    "/dashboard/supplier-sheet/clear",
    "Clear the supplier-escalation sheet",
    handleDashboardSupplierSheetClear,
  );
  dashboardPost(
    "/dashboard/connect/:provider",
    "Mint a signed install grant + return the provider install URL",
    handleDashboardConnect,
  );
  dashboardPost(
    "/dashboard/connections/:provider/disconnect",
    "Disconnect (revoke) a connector",
    handleDashboardDisconnect,
  );
  dashboardPost(
    "/dashboard/account/delete",
    "Delete the tenant's own account (irreversible)",
    handleDashboardAccountDelete,
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
