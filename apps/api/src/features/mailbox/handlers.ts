import { Effect } from "effect";
import { timingSafeEqual } from "node:crypto";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConnectorCredentialStore,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import {
  startGmailWatch,
  GRAPH_INBOX_RESOURCE,
  GRAPH_JUNK_RESOURCE,
  graphCreateSubscription,
  GRAPH_SUBSCRIPTION_TTL_MS,
} from "@support-agent/providers";
import {
  type ApiConfig,
  type ApiLayer,
} from "../../bootstrap.js";
import {
  sendJson,
  opaqueCause,
  sendRedirect,
  readQuery,
} from "../../platform/http.js";
import {
  tenantHasCurrentLegalAcceptance,
  sendLegalAcceptanceRequired,
} from "../../auth/dashboard-context.js";
import { verifyInstallGrant } from "../../auth/install-grant.js";
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
import { verifyState } from "../shopify/install.js";
import {
  dashboardConnectErrorRedirect,
  dashboardConnectRedirect,
} from "../connect/redirect.js";
import {
  activeMailboxConflict,
  alreadyConnectedRedirect,
  type OAuthMailboxProvider,
} from "../connect/guard.js";
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
  backfillUnreadGmailInbox,
  findTenantByGmailMailbox,
  handleGmailPushNotification,
  parseGmailPushEnvelope,
} from "./gmail-webhook.js";

export const handleGoogleInstall = async (
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
 * Shared by the OAuth callbacks: when the tenant already has an ACTIVE
 * connection for `provider` under a DIFFERENT mailbox, answer the request
 * (browser → redirect to the integrations page with the conflict spelled
 * out; otherwise JSON 409) and return `true` so the caller stops. Same-
 * mailbox re-auth returns `false` — the upsert repairs tokens in place.
 */
export const rejectWhenMailboxConnected = async (
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
 *      replies that predate the install can resume existing tickets.
 *
 * If steps 1-4 succeed but 5 fails, we still 200 — the credentials are
 * saved and a re-install (or a scheduled watch-refresh) can recover.
 * Failing the install over a flaky watch call would orphan the OAuth grant.
 */
export const handleGoogleCallback = async (
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
              // Mirrors startGmailWatch's default label set. The renewal
              // cron re-registers any watch whose marker lacks SPAM.
              watchLabelIds: ["INBOX", "SPAM"],
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
export const handleMicrosoftInstall = async (
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
export const handleMicrosoftCallback = async (
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
    const notificationUrl = `${cfg.microsoft.notificationUrl.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}`;
    const expirationDateTime = new Date(
      Date.now() + GRAPH_SUBSCRIPTION_TTL_MS,
    ).toISOString();
    const metadata: Record<string, unknown> = {};
    try {
      subscription = await graphCreateSubscription({
        token: token.accessToken,
        notificationUrl,
        clientState: cfg.microsoft.webhookClientState,
        expirationDateTime,
        resource: GRAPH_INBOX_RESOURCE,
      });
      metadata["subscriptionId"] = subscription.id;
      metadata["subscriptionExpiresAt"] = subscription.expirationDateTime;
    } catch (cause) {
      req.log.error(
        { err: cause },
        "[microsoft callback] subscription registration failed",
      );
    }
    // Junk Email folder subscription — spam is ingested, not filtered. Its
    // own try/catch so a junk-folder failure never costs the inbox one; the
    // renewal cron recreates whichever is missing.
    try {
      const junk = await graphCreateSubscription({
        token: token.accessToken,
        notificationUrl,
        clientState: cfg.microsoft.webhookClientState,
        expirationDateTime,
        resource: GRAPH_JUNK_RESOURCE,
      });
      metadata["junkSubscriptionId"] = junk.id;
      metadata["junkSubscriptionExpiresAt"] = junk.expirationDateTime;
    } catch (cause) {
      req.log.error(
        { err: cause },
        "[microsoft callback] junk subscription registration failed",
      );
    }
    if (Object.keys(metadata).length > 0) {
      const patchExit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.gen(function* () {
            const store = yield* ConnectorCredentialStore;
            return yield* store.patchMetadata({
              tenantId: TenantId(tenantId),
              provider: "outlook",
              shopDomain: email,
              metadata,
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
export const handleGmailWebhook = async (
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
export const handleGraphWebhook = async (
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
