import { Effect } from "effect";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ConnectorCredentialStore,
  TransactionRunner,
  verifyShopifyWebhookHmac,
} from "@support-agent/services";
import { ConnectorNotFound, TenantId } from "@support-agent/agent-core";
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
  readRawBody,
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

// ============================================================
// Helpers
// ============================================================

const readQuery = (
  req: IncomingMessage,
): { url: URL; params: Record<string, string> } => {
  // The Host header is trusted only for *parsing* the path — we never echo
  // it back to the client. For URL construction we use a placeholder that
  // makes `new URL(...)` happy.
  const u = new URL(req.url ?? "/", "http://placeholder");
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  return { url: u, params };
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendRedirect = (res: ServerResponse, target: string): void => {
  res.writeHead(302, { Location: target });
  res.end();
};

const sendRedirectWithHeaders = (
  res: ServerResponse,
  target: string,
  headers: Record<string, string | ReadonlyArray<string>>,
): void => {
  res.writeHead(302, { Location: target, ...headers });
  res.end();
};

const sendText = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
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

const sendHtml = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

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
  req: IncomingMessage,
  res: ServerResponse,
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
  req: IncomingMessage,
  res: ServerResponse,
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

  // Install succeeded — redirect to our App URL (`/installed`) per
  // Shopify's non-embedded app pattern, echoing the `host` + `shop` so
  // the landing page has the merchant context. JSON callers (tests,
  // curl with `Accept: application/json`) still get a structured
  // success body so assertions don't have to follow redirects.
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
const handleInstalledPage = (
  req: IncomingMessage,
  res: ServerResponse,
): void => {
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
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
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
</html>`);
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
  req: IncomingMessage,
  res: ServerResponse,
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

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (cause) {
    sendJson(res, 413, {
      error: "body_too_large_or_unreadable",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

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
  // eslint-disable-next-line no-console
  console.error("[webhook app/uninstalled] revoke failed:", revokeResult.left);
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
  req: IncomingMessage,
  res: ServerResponse,
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

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (cause) {
    sendJson(res, 413, {
      error: "body_too_large_or_unreadable",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }

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
    // eslint-disable-next-line no-console
    console.error(
      "[compliance webhook] tenant lookup failed:",
      tenantExit.cause,
    );
    return { tenantId: null, shop, rawBody };
  }
  return { tenantId: tenantExit.value, shop, rawBody };
};

/** POST /webhooks/shopify/customers/data_request */
const handleCustomersDataRequest = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: IncomingMessage,
  res: ServerResponse,
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
    // eslint-disable-next-line no-console
    console.error(
      "[webhook customers/data_request] record failed:",
      recordExit.cause,
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
  req: IncomingMessage,
  res: ServerResponse,
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
    // eslint-disable-next-line no-console
    console.error(
      "[webhook customers/redact] redact failed:",
      redactExit.cause,
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
  req: IncomingMessage,
  res: ServerResponse,
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
    // eslint-disable-next-line no-console
    console.error(
      "[webhook shop/redact] redact failed:",
      redactExit.cause,
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
  req: IncomingMessage,
  res: ServerResponse,
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
 *
 * If steps 1-4 succeed but 5 fails, we still 200 — the credentials are
 * saved and a re-install (or a scheduled watch-refresh) can recover.
 * Failing the install over a flaky watch call would orphan the OAuth grant.
 */
const handleGoogleCallback = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: IncomingMessage,
  res: ServerResponse,
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
      // eslint-disable-next-line no-console
      console.error("[google callback] watch registration failed:", cause);
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
      // eslint-disable-next-line no-console
      console.error(
        "[google callback] metadata patch failed:",
        patchExit.cause,
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
      provider,
      email,
      scopes: token.scope,
      watchRegistered: !!watch,
    });
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
  req: IncomingMessage,
  res: ServerResponse,
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

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (cause) {
    sendJson(res, 413, {
      error: "body_too_large_or_unreadable",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }

  if (!tenantId) {
    const payload = parseGmailPushEnvelope(rawBody);
    if (!payload) {
      // eslint-disable-next-line no-console
      console.warn("[gmail webhook] unparseable push envelope; dropping");
      sendJson(res, 200, { ok: true });
      return;
    }

    const tenantExit = await Effect.runPromiseExit(
      Effect.provide(findTenantByGmailMailbox(payload.emailAddress), layer),
    );
    if (tenantExit._tag !== "Success") {
      // eslint-disable-next-line no-console
      console.error("[gmail webhook] tenant lookup failed:", tenantExit.cause);
      sendJson(res, 200, { ok: true });
      return;
    }
    tenantId = tenantExit.value;
    if (!tenantId) {
      // eslint-disable-next-line no-console
      console.warn(
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
    // eslint-disable-next-line no-console
    console.error("[gmail webhook] push handling failed:", cause);
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
  req: IncomingMessage,
  res: ServerResponse,
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

export const startServer = async (
  cfg: ApiConfig,
): Promise<ServerHandle> => {
  const layer = buildApiLayers(cfg);

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    void (async () => {
      try {
        if (method === "GET" && url.startsWith("/shopify/install")) {
          await handleShopifyInstall(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/shopify/auth/callback")) {
          await handleShopifyCallback(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/installed")) {
          handleInstalledPage(req, res);
          return;
        }
        if (
          method === "POST" &&
          url.startsWith("/webhooks/shopify/app/uninstalled")
        ) {
          await handleAppUninstalled(cfg, layer, req, res);
          return;
        }
        if (
          method === "POST" &&
          url.startsWith("/webhooks/shopify/customers/data_request")
        ) {
          await handleCustomersDataRequest(cfg, layer, req, res);
          return;
        }
        if (
          method === "POST" &&
          url.startsWith("/webhooks/shopify/customers/redact")
        ) {
          await handleCustomersRedact(cfg, layer, req, res);
          return;
        }
        if (
          method === "POST" &&
          url.startsWith("/webhooks/shopify/shop/redact")
        ) {
          await handleShopRedact(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/google/install")) {
          handleGoogleInstall(cfg, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/google/auth/callback")) {
          await handleGoogleCallback(cfg, layer, req, res);
          return;
        }
        if (
          method === "POST" &&
          url.startsWith("/webhooks/conversations/gmail")
        ) {
          await handleGmailWebhook(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url.startsWith("/approvals/")) {
          await handleApprovalDecision(cfg, layer, req, res);
          return;
        }
        if (method === "GET" && url === "/healthz") {
          sendText(res, 200, "ok");
          return;
        }
        sendJson(res, 404, { error: "not_found" });
      } catch (cause) {
        // eslint-disable-next-line no-console
        console.error("[api] unhandled error:", cause);
        sendJson(res, 500, { error: "internal" });
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(cfg.port, () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : cfg.port;
      // eslint-disable-next-line no-console
      console.log(`[api] listening on http://localhost:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) =>
            server.close(() => {
              res();
            }),
          ),
      });
    });
  });
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
