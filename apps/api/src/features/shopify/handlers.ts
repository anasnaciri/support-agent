import { Cause, Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConnectorCredentialStore,
  ShopifyAppProvisioningStore,
  TransactionRunner,
  verifyShopifyWebhookHmac,
} from "@support-agent/services";
import {
  ConnectorNotFound,
  TenantId,
} from "@support-agent/agent-core";
import {
  buildInstallUrl,
  buildManagedInstallUrl,
  isValidShopDomain,
  isValidShopifyInstallLink,
  normalizeShopDomain,
  signState,
  verifyCallbackHmac,
  verifyState,
} from "./install.js";
import { exchangeCodeForToken } from "./callback.js";
import { verifyInstallGrant } from "../../auth/install-grant.js";
import {
  resolveShopifyAppForShop,
  resolveShopifyAppForTenant,
  type GlobalShopifyApp,
} from "./app-resolver.js";
import { dashboardConnectRedirect } from "../connect/redirect.js";
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
  parseFulfillmentShipmentPayload,
  parseShopRedact,
  parseUninstallPayload,
} from "./webhook.js";
import {
  recordDataRequest,
  redactCustomer,
  redactShop,
} from "../account/compliance-redaction.js";
import {
  appUninstalledWebhookUrl,
  fulfillmentWebhookUrls,
  registerAppUninstalledWebhook,
  registerFulfillmentWebhooks,
} from "./webhook-registration.js";
import {
  type ApiConfig,
  type ApiLayer,
} from "../../bootstrap.js";
import {
  escapeHtml,
  readQuery,
  parseCookies,
  sendJson,
  sendHtml,
  sendRedirect,
  sendRedirectWithHeaders,
  opaqueCause,
  SHOPIFY_INSTALL_COOKIE,
  shopifyInstallCookie,
  clearShopifyInstallCookie,
} from "../../platform/http.js";
import {
  tenantHasCurrentLegalAcceptance,
  sendLegalAcceptanceRequired,
} from "../../auth/dashboard-context.js";
import {
  shipmentPublisher,
  shopifyPolicyImportPublisher,
} from "../../platform/pgboss.js";
import {
  shopifyShipmentRolloutMetadata,
} from "./shipment-rollout-reconciliation.js";

/** The deployment-wide Shopify app (SaaS path), or null in a pure-pilot
 * deployment that ships no global app (audit A6). */
export const globalShopifyApp = (cfg: ApiConfig): GlobalShopifyApp | null =>
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
export type ResolveTenantAppOutcome =
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

export const resolveTenantShopifyApp = async (
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
export const sendShopifyAppResolveError = (
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
export const resolveShopWebhookSecret = async (
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
export const resolveProvisionedShop = async (
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

/**
 * The store-unique install link the operator pasted at provisioning, or null.
 * When present (pilot custom distribution), the dashboard-initiated install
 * redirects the merchant straight to it — the link drives Shopify's own
 * install flow and lands back on our OAuth callback — instead of us building
 * the `/admin/oauth/authorize` URL. Re-validated here so a malformed stored
 * value falls through to the normal flow rather than redirecting anywhere odd.
 */
export const resolveProvisionedInstallLink = async (
  layer: ApiLayer,
  tenantId: string,
): Promise<string | null> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        const row = yield* store.get(TenantId(tenantId));
        return row?.installLink ?? null;
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success" || !exit.value) return null;
  return isValidShopifyInstallLink(exit.value) ? exit.value : null;
};

export const handleShopifyInstall = async (
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
    // Pilot custom distribution: if the operator pasted the store-unique
    // install link Shopify generated for this store, hand the merchant
    // straight to it instead of building our own OAuth authorize URL. The
    // link drives Shopify's install flow and lands on our callback, which
    // resolves the tenant by the recorded shop (no state of our design).
    if (cfg.shopifyConnectRequiresProvisioning) {
      const installLink = await resolveProvisionedInstallLink(layer, tenant);
      if (installLink) {
        sendRedirectWithHeaders(res, installLink, {
          "Set-Cookie": clearShopifyInstallCookie(
            cfg.shopify.callbackUrl.startsWith("https://"),
          ),
        });
        return;
      }
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
export const handleShopifyCallback = async (
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
  const fulfillmentWebhooks = await registerFulfillmentWebhooks({
    shop,
    accessToken: token.accessToken,
    apiVersion: cfg.shopify.apiVersion,
    webhookUrls: fulfillmentWebhookUrls(cfg.shopify.callbackUrl),
  }).catch((cause) => {
    sendJson(res, 502, {
      error: "webhook_registration_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  });
  if (!fulfillmentWebhooks) return;

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
                    fulfillments: fulfillmentWebhooks.map((webhook) => ({
                      topic: webhook.topic,
                      id: webhook.id,
                      uri: webhook.uri,
                      status: webhook.status,
                      registeredAt: new Date().toISOString(),
                    })),
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
  try {
    await shipmentPublisher(cfg.databaseUrl)({
      kind: "shopify.backfill",
      tenantId,
    });
    await Effect.runPromise(
      Effect.provide(
        ConnectorCredentialStore.pipe(
          Effect.flatMap((store) =>
            store.patchMetadata({
              tenantId: TenantId(tenantId),
              provider: "shopify",
              shopDomain: shop,
              metadata: shopifyShipmentRolloutMetadata(
                fulfillmentWebhooks,
              ),
            }),
          ),
        ),
        layer,
      ),
    );
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shopify-shipment-backfill] enqueue failed for tenant=${tenantId}: ${
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

// The decoded `host` param must be a plain admin.shopify.com path —
// charset-restricted so it can't break out of the href attribute even
// before escaping (audit S5).
export const ADMIN_HOST_RE = /^admin\.shopify\.com\/[A-Za-z0-9./_-]*$/u;

export const handleInstalledPage = (req: FastifyRequest, res: FastifyReply): void => {
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
  <title>support-agent: connected</title>
  <style>
    body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
    code { background: #f3f3f3; padding: 0.1em 0.3em; border-radius: 4px; }
    .ok { color: #1a7a3a; }
  </style>
</head>
<body>
  <h1 class="ok">Connected</h1>
  <p>${safeShop ? `Your store <code>${safeShop}</code> is connected to support-agent.` : "Your store is connected to support-agent."}</p>
  <p>You can ${adminAnchor} now. A dashboard for managing tickets, agents, and approvals is on the way.</p>
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
export const handleAppUninstalled = async (
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
//     customer is redacted on the merchant side. We delete every ticket
//     (and its transitions, audit, approvals) matching the email or
//     customer id stamped at ticket-create time.
//   - shop/redact — 48h after a merchant uninstalls. We delete every
//     row tied to the tenant: tickets, audit, approvals, connector
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
export const verifyComplianceWebhook = async (
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

export const handleFulfillmentShipment = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<void> => {
  const verified = await verifyComplianceWebhook(cfg, layer, req, res);
  if (!verified) return;
  if (!verified.tenantId) {
    sendJson(res, 200, { ok: true, action: "noop_unknown_shop" });
    return;
  }
  const discoveries = parseFulfillmentShipmentPayload(verified.rawBody);
  try {
    const publish = shipmentPublisher(cfg.databaseUrl);
    await Promise.all(
      discoveries.map((shipment) =>
        publish({
          kind: "shopify.fulfillment",
          shipment: {
            tenantId: TenantId(verified.tenantId!),
            source: "shopify",
            ...shipment,
          },
        }),
      ),
    );
  } catch (cause) {
    req.log.error(
      { err: cause },
      "[shopify fulfillment webhook] enqueue failed",
    );
    sendJson(res, 503, { error: "shipment_enqueue_failed" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    action: discoveries.length > 0 ? "enqueued" : "noop_untracked",
  });
};

/** POST /webhooks/shopify/customers/data_request */
export const handleCustomersDataRequest = async (
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
export const handleCustomersRedact = async (
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
    matchedTickets: redactExit.value.matchedTicketIds.length,
  });
};

/** POST /webhooks/shopify/shop/redact */
export const handleShopRedact = async (
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
