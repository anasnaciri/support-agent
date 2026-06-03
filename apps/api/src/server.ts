import { Effect } from "effect";
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
  ConnectorCredentialStore,
  TransactionRunner,
  verifyShopifyWebhookHmac,
} from "@support-agent/services";
import { ConnectorNotFound, TenantId } from "@support-agent/agent-core";
import {
  approvalDetail,
  approvalsList,
  auditList,
  caseDetail,
  caseEvents,
  casesList,
  DbClient,
  findTenantIdByWorkosOrg,
  parsePageNumber,
  parsePageSize,
  todaySummary,
  type DrizzleDb,
} from "@support-agent/db";
import { parseDashboardAuth } from "./dashboard-auth.js";
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
import { dashboardConnectRedirect } from "./post-connect-redirect.js";
import {
  assertShopifyShopConnectable,
  claimShopifyShopForTenant,
  findTenantByShop,
  resolveTenantByShop,
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
import { startGmailWatch } from "@support-agent/providers";
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
  | { readonly ok: true; readonly tenantId: string }
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
  return { ok: true, tenantId };
};

/** Read a non-empty string query/param value, else undefined. */
const strField = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = source[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

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
const handleShopifyInstall = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const { params } = readQuery(req);
  const shopParam = params["shop"];
  const shop = shopParam ? normalizeShopDomain(shopParam) : null;
  let tenant = params["tenant"];
  if (shopParam && !shop) {
    sendJson(res, 400, { error: "missing_or_invalid_shop" });
    return;
  }
  if (!shop) {
    if (!tenant) {
      sendJson(res, 400, { error: "missing_tenant" });
      return;
    }
    const pendingState = signState(cfg.stateSigningKey, tenant);
    const managedInstallUrl = buildManagedInstallUrl({
      clientId: cfg.shopify.clientId,
    });
    sendRedirectWithHeaders(res, managedInstallUrl, {
      "Set-Cookie": shopifyInstallCookie(
        pendingState,
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
        Effect.provide(resolveTenantByShop(shop), layer),
      );
      if (resolveExit._tag !== "Success") {
        sendJson(res, 500, {
          error: "tenant_resolve_failed",
          detail: String(resolveExit.cause),
        });
        return;
      }
      tenant = resolveExit.value;
    }
  } else {
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

  const state = signState(cfg.stateSigningKey, tenant);
  const installUrl = buildInstallUrl({
    shop,
    clientId: cfg.shopify.clientId,
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
 *   2. Shopify Custom Distribution — merchant clicked the Partner Dashboard
 *      install link. Shopify drove the OAuth flow directly, so we don't
 *      see the merchant before the callback and there's no `state` of our
 *      design. We look up (or auto-create) a tenant for this shop via
 *      `resolveTenantByShop`, gated on the partial unique index on
 *      `tenants.shopify_domain`.
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
  const hmacOk = verifyCallbackHmac({
    clientSecret: cfg.shopify.clientSecret,
    query: params,
    receivedHmac: hmac,
  });
  if (!hmacOk) {
    sendJson(res, 401, { error: "hmac_verification_failed" });
    return;
  }

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
      Effect.provide(resolveTenantByShop(shop), layer),
    );
    if (resolveExit._tag !== "Success") {
      sendJson(res, 500, {
        error: "tenant_resolve_failed",
        detail: String(resolveExit.cause),
      });
      return;
    }
    tenantId = resolveExit.value;
  }

  let token: { accessToken: string; scope: ReadonlyArray<string> };
  try {
    token = await exchangeCodeForToken({
      shop,
      clientId: cfg.shopify.clientId,
      clientSecret: cfg.shopify.clientSecret,
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

  const hmacOk = verifyShopifyWebhookHmac({
    clientSecret: cfg.shopify.clientSecret,
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

  const hmacOk = verifyShopifyWebhookHmac({
    clientSecret: cfg.shopify.clientSecret,
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
    Effect.provide(redactShop(verified.tenantId), layer),
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
const handleGoogleInstall = (
  cfg: ApiConfig,
  req: FastifyRequest,
  res: FastifyReply,
): void => {
  if (!cfg.google) {
    sendJson(res, 503, { error: "google_oauth_not_configured" });
    return;
  }
  const { params } = readQuery(req);
  const tenant = params["tenant"];
  if (!tenant) {
    sendJson(res, 400, { error: "missing_tenant" });
    return;
  }
  const providerParam = params["provider"] ?? params["connector"] ?? "gmail";
  if (!isGoogleOAuthProvider(providerParam)) {
    sendJson(res, 400, {
      error: "unsupported_google_provider",
      provider: providerParam,
    });
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
      handleGoogleInstall(cfg, req, res);
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

  // ---- System ----
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
    close: () => app.close(),
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
