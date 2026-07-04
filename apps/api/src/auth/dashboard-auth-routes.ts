import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createTenantForOrg } from "@support-agent/db";

import type { RouteContext } from "../platform/context.js";
import { parseJsonBody, sendJson, strField } from "../platform/http.js";
import { dashboardUserDecisionUuid } from "./dashboard-user-id.js";
import {
  getDashboardSessionCodec,
  getDashboardVerifier,
  getWorkosOrgAdminDirectory,
  makeLegalAcceptance,
  runWithDb,
} from "./dashboard-context.js";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE_NAME,
  buildAuthorizeUrl,
  buildWorkosLogoutUrl,
  decodeAccessTokenSessionId,
  exchangeAuthorizationCode,
  parseCookieHeader,
  refreshAccessToken,
  sanitizeReturnPath,
  serializeSessionClearCookie,
  serializeSessionCookie,
  serializeStateClearCookie,
  serializeStateCookie,
  signOAuthState,
  verifyOAuthState,
  type SessionCodec,
  type SessionPayload,
} from "./dashboard-session.js";
import type { WorkosOrgAdminDirectory } from "./workos-directory.js";

// ============================================================
// Dashboard BFF auth routes (`/dashboard/auth/*`) — SPA cookie session
// ============================================================
//
// The Vite SPA has no server, so apps/api owns the WorkOS OAuth handshake and
// the httpOnly session cookie. These routes are ADDITIVE — the Next dashboard's
// bearer flow (its own /callback + wos-session cookie) is untouched. When the
// BFF isn't configured (`cfg.dashboardBff` null) every route responds 503.

interface AuthRouteDeps {
  /** Override the WorkOS OAuth HTTP calls (tests). Prod uses global fetch. */
  readonly workosFetch?: typeof fetch;
}

export type OrglessSessionRecovery =
  | {
      readonly kind: "recovered";
      readonly organizationId: string;
      readonly session: SessionPayload;
    }
  | { readonly kind: "needs_onboarding" }
  | { readonly kind: "lookup_failed" }
  | { readonly kind: "remint_failed" };

export const recoverOrglessSession = async (input: {
  readonly admin: WorkosOrgAdminDirectory;
  readonly clientId: string;
  readonly apiKey: string;
  readonly refreshToken: string;
  readonly workosUserId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<OrglessSessionRecovery> => {
  const memberships = await input.admin.listOrganizationMemberships(
    input.workosUserId,
  );
  if (memberships === null) return { kind: "lookup_failed" };
  const organizationId = memberships[0];
  if (!organizationId) return { kind: "needs_onboarding" };

  const refreshed = await refreshAccessToken({
    clientId: input.clientId,
    apiKey: input.apiKey,
    refreshToken: input.refreshToken,
    organizationId,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!refreshed.ok) return { kind: "remint_failed" };
  return { kind: "recovered", organizationId, session: refreshed.session };
};

const qstr = (query: unknown, key: string): string | undefined => {
  const v = (query as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

const hstr = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const cookie = (req: FastifyRequest, name: string): string | undefined =>
  parseCookieHeader(hstr(req.headers.cookie))[name];

export const registerDashboardAuthRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
  deps: AuthRouteDeps = {},
): void => {
  const { cfg } = ctx;
  const bff = cfg.dashboardBff;
  const workos = cfg.workos;
  const fetchOpt = deps.workosFetch ? { fetchImpl: deps.workosFetch } : {};

  // Cross-site prod (https redirect) → Secure/SameSite=None cookies; local http
  // dev → Lax/no-Secure. Derived from the api's own callback URL scheme.
  const secure = bff ? bff.redirectUri.startsWith("https:") : true;

  // Guard: the BFF needs the session codec + WorkOS creds. Any missing piece →
  // 503, so a half-configured deployment fails loud rather than half-working.
  const unavailable = (res: FastifyReply): FastifyReply =>
    sendJson(res, 503, { error: "dashboard_bff_not_configured" });

  const bffReady = (
    req: FastifyRequest,
  ):
    | {
        readonly codec: SessionCodec;
        readonly clientId: string;
        readonly apiKey: string;
        readonly redirectUri: string;
        readonly spaOrigin: string;
      }
    | null => {
    const codec = getDashboardSessionCodec(req);
    if (!bff || !workos?.apiKey || !codec) return null;
    return {
      codec,
      clientId: workos.clientId,
      apiKey: workos.apiKey,
      redirectUri: bff.redirectUri,
      spaOrigin: bff.spaOrigins[0]!,
    };
  };

  const schema = { schema: { tags: ["dashboard-auth"] as string[] } };

  // ---- Login: 302 → WorkOS authorize, dropping a signed-state nonce cookie ----
  app.get("/dashboard/auth/login", schema, async (req, res) => {
    const ready = bffReady(req);
    if (!ready) return unavailable(res);
    const returnTo = sanitizeReturnPath(qstr(req.query, "returnTo"));
    const nonce = randomBytes(18).toString("base64url");
    const state = signOAuthState(cfg.stateSigningKey, { nonce, returnTo });
    const screenHint =
      qstr(req.query, "screen_hint") === "sign-up" ? "sign-up" : undefined;
    const url = buildAuthorizeUrl({
      clientId: ready.clientId,
      redirectUri: ready.redirectUri,
      state,
      ...(screenHint ? { screenHint } : {}),
    });
    res.header("set-cookie", serializeStateCookie(nonce, { secure }));
    return res.redirect(url);
  });

  // ---- Callback: verify state ↔ nonce cookie, exchange code, mint session ----
  app.get("/dashboard/auth/callback", schema, async (req, res) => {
    const ready = bffReady(req);
    if (!ready) return unavailable(res);
    const failDest = `${ready.spaOrigin}/sign-in?error=auth_failed`;
    const code = qstr(req.query, "code");
    const stateToken = qstr(req.query, "state");
    const state = stateToken
      ? verifyOAuthState(cfg.stateSigningKey, stateToken)
      : null;
    const nonceCookie = cookie(req, OAUTH_STATE_COOKIE);
    // Bind the callback to the browser that started login (anti login-CSRF).
    if (!code || !state || !nonceCookie || state.nonce !== nonceCookie) {
      res.header("set-cookie", serializeStateClearCookie({ secure }));
      return res.redirect(failDest);
    }
    const outcome = await exchangeAuthorizationCode({
      clientId: ready.clientId,
      apiKey: ready.apiKey,
      code,
      ...fetchOpt,
    });
    if (!outcome.ok) {
      res.header("set-cookie", serializeStateClearCookie({ secure }));
      return res.redirect(failDest);
    }
    const sealed = await ready.codec.seal(outcome.session);
    res.header("set-cookie", [
      serializeSessionCookie(sealed, { secure }),
      serializeStateClearCookie({ secure }),
    ]);
    return res.redirect(`${ready.spaOrigin}${sanitizeReturnPath(state.returnTo)}`);
  });

  // ---- Session (whoami): identity for the SPA, refreshing in place on lapse ----
  app.get("/dashboard/auth/session", schema, async (req, res) => {
    const ready = bffReady(req);
    if (!ready) return unavailable(res);
    const verifier = getDashboardVerifier(req);
    if (!verifier) return unavailable(res);
    const raw = cookie(req, SESSION_COOKIE_NAME);
    if (!raw) return sendJson(res, 401, { error: "unauthenticated" });
    let sealed = await ready.codec.unseal(raw);
    if (!sealed) return sendJson(res, 401, { error: "unauthenticated" });

    let verified = await verifier.verify(sealed.accessToken);
    // A RECOVERABLE failure — expired, or a live token signed by a rotated-out
    // JWKS key (`invalid_token`) — is refreshed in place with the refresh token.
    // A dead refresh (revoked / expired) means the session is genuinely over →
    // 401. `missing_claims` is handled below: it can be true onboarding OR a
    // WorkOS session that lost its active org but still has memberships.
    if (
      !verified.ok &&
      verified.reason !== "missing_claims" &&
      sealed.refreshToken
    ) {
      const refreshed = await refreshAccessToken({
        clientId: ready.clientId,
        apiKey: ready.apiKey,
        refreshToken: sealed.refreshToken,
        ...fetchOpt,
      });
      if (!refreshed.ok) {
        return sendJson(res, 401, { error: "unauthenticated" });
      }
      sealed = refreshed.session;
      res.header(
        "set-cookie",
        serializeSessionCookie(await ready.codec.seal(sealed), { secure }),
      );
      verified = await verifier.verify(sealed.accessToken);
    }
    if (verified.ok) {
      return sendJson(res, 200, {
        organizationId: verified.claims.organizationId,
        userId: dashboardUserDecisionUuid(verified.claims.workosUserId),
        user: sealed.user,
      });
    }
    // A validly-signed token that lacks an org claim (`missing_claims`) is often
    // a brand-new self-service user, but WorkOS can also return an org-less
    // token for a user who already has memberships. Re-mint into an existing
    // membership first so an existing workspace never gets bounced to onboarding.
    if (!verified.ok && verified.reason === "missing_claims") {
      const admin = getWorkosOrgAdminDirectory(req);
      if (admin && sealed.refreshToken && sealed.user.id) {
        const recovered = await recoverOrglessSession({
          admin,
          clientId: ready.clientId,
          apiKey: ready.apiKey,
          refreshToken: sealed.refreshToken,
          workosUserId: sealed.user.id,
          ...fetchOpt,
        });
        if (recovered.kind === "lookup_failed") {
          return sendJson(res, 503, { error: "org_lookup_failed" });
        }
        if (recovered.kind === "remint_failed") {
          return sendJson(res, 401, { error: "unauthenticated" });
        }
        if (recovered.kind === "recovered") {
          sealed = recovered.session;
          res.header(
            "set-cookie",
            serializeSessionCookie(await ready.codec.seal(sealed), { secure }),
          );
          verified = await verifier.verify(sealed.accessToken);
          if (verified.ok) {
            return sendJson(res, 200, {
              organizationId: verified.claims.organizationId,
              userId: dashboardUserDecisionUuid(verified.claims.workosUserId),
              user: sealed.user,
            });
          }
          return sendJson(res, 401, { error: "unauthenticated" });
        }
      }
      return sendJson(res, 200, {
        needsOnboarding: true,
        userId: dashboardUserDecisionUuid(sealed.user.id),
        user: sealed.user,
      });
    }
    return sendJson(res, 401, { error: "unauthenticated" });
  });

  // ---- Refresh: re-mint the session from its refresh token (SPA calls on 401) ----
  app.post("/dashboard/auth/refresh", schema, async (req, res) => {
    const ready = bffReady(req);
    if (!ready) return unavailable(res);
    const raw = cookie(req, SESSION_COOKIE_NAME);
    const sealed = raw ? await ready.codec.unseal(raw) : null;
    if (!sealed?.refreshToken) {
      return sendJson(res, 401, { error: "unauthenticated" });
    }
    const refreshed = await refreshAccessToken({
      clientId: ready.clientId,
      apiKey: ready.apiKey,
      refreshToken: sealed.refreshToken,
      ...fetchOpt,
    });
    if (!refreshed.ok) {
      res.header("set-cookie", serializeSessionClearCookie({ secure }));
      return sendJson(res, 401, { error: "refresh_failed" });
    }
    res.header(
      "set-cookie",
      serializeSessionCookie(await ready.codec.seal(refreshed.session), {
        secure,
      }),
    );
    return sendJson(res, 200, { ok: true });
  });

  // ---- Onboard: provision the org (if new), re-mint the cookie, create the
  // first tenant. SPA-only (cookie) counterpart of the Next server action.
  //
  // A brand-new self-service user has NO WorkOS org, so their token doesn't
  // verify to one and `/session` reports needsOnboarding. This creates the org
  // server-side (the browser has no WORKOS_API_KEY), adds the user, re-mints the
  // cookie so it now carries the org, then creates the tenant. Idempotent: a
  // user who already has an org (a prior attempt, or an invite) reuses it via
  // listOrganizationMemberships, and createTenantForOrg returns the existing
  // tenant on retry. The Next dashboard keeps using POST /dashboard/onboarding
  // (bearer, org already provisioned in its own server action).
  app.post("/dashboard/auth/onboard", schema, async (req, res) => {
    const ready = bffReady(req);
    if (!ready) return unavailable(res);
    const verifier = getDashboardVerifier(req);
    if (!verifier) return unavailable(res);

    const raw = cookie(req, SESSION_COOKIE_NAME);
    const sealed = raw ? await ready.codec.unseal(raw) : null;
    // A sealed cookie is the auth proof here: it's a JWE only we can mint (from a
    // real WorkOS exchange), so `sealed.user.id` is a trusted WorkOS user id.
    if (!sealed?.user.id) {
      return sendJson(res, 401, { error: "unauthenticated" });
    }
    const workosUserId = sealed.user.id;

    // Validate the onboarding form (mirrors POST /dashboard/onboarding).
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

    // If the token already verifies to an org (a retry after tenant-create
    // failed, or an org-scoped session), reuse it and skip the re-mint.
    // Otherwise provision: reuse an existing membership or create a fresh org,
    // then re-mint the cookie so it carries the resolved org.
    const verified = await verifier.verify(sealed.accessToken);
    let organizationId: string;
    if (verified.ok) {
      // Already org-scoped (a retry after tenant-create failed) → reuse, no re-mint.
      organizationId = verified.claims.organizationId;
    } else if (verified.reason === "missing_claims") {
      // Validly-signed token that carries no org → the genuine provision ticket.
      // Any OTHER failure (invalid / expired / dead) is NOT a signal to create an
      // org — 401 so the SPA re-syncs the session (which refreshes) and retries.
      const admin = getWorkosOrgAdminDirectory(req);
      if (!admin) {
        return sendJson(res, 503, { error: "workos_admin_not_configured" });
      }
      // A LOOKUP FAILURE (null) is NOT "no orgs": provisioning then would fork an
      // already-onboarded user into a second org. Fail retryably instead.
      const memberships =
        await admin.listOrganizationMemberships(workosUserId);
      if (memberships === null) {
        return sendJson(res, 503, { error: "org_lookup_failed" });
      }
      const existing = memberships[0];
      if (existing) {
        organizationId = existing;
      } else {
        const created = await admin.createOrganization(name);
        if (!created) return sendJson(res, 502, { error: "org_create_failed" });
        organizationId = created.id;
        await admin.addOrganizationMembership(organizationId, workosUserId);
      }
      const refreshed = await refreshAccessToken({
        clientId: ready.clientId,
        apiKey: ready.apiKey,
        refreshToken: sealed.refreshToken,
        organizationId,
        ...fetchOpt,
      });
      // The re-mint MUST land — the SPA's next request has to carry the org. The
      // org + membership are already created, so a client retry is idempotent.
      if (!refreshed.ok) {
        return sendJson(res, 500, { error: "session_remint_failed" });
      }
      res.header(
        "set-cookie",
        serializeSessionCookie(await ready.codec.seal(refreshed.session), {
          secure,
        }),
      );
    } else {
      // Invalid / expired / otherwise unverifiable token — NOT an onboarding
      // signal. Re-sync via /session (which refreshes) then retry.
      return sendJson(res, 401, { error: "unauthenticated" });
    }

    const userId = dashboardUserDecisionUuid(workosUserId);
    const result = await runWithDb(ctx.layer, (db) =>
      createTenantForOrg(db, {
        organizationId,
        name: name.slice(0, 120),
        notificationEmail: email.slice(0, 254),
        legalAcceptance: makeLegalAcceptance(userId),
      }),
    );
    return sendJson(res, 200, { ...result, organizationId });
  });

  // ---- Logout: clear our cookie AND end the WorkOS session (POST-only, S13).
  // Clearing only our cookie leaves the AuthKit session on the WorkOS domain
  // alive, so the next /login would silently re-authenticate the previous
  // account. We can't clear a cookie on another domain server-side, so we hand
  // the SPA the WorkOS end-session URL (keyed by the token's `sid`) and it
  // navigates there; WorkOS then redirects back to `return_to`.
  app.post("/dashboard/auth/logout", schema, async (req, res) => {
    res.header("set-cookie", serializeSessionClearCookie({ secure }));
    const ready = bffReady(req);
    const raw = cookie(req, SESSION_COOKIE_NAME);
    const sealed = ready && raw ? await ready.codec.unseal(raw) : null;
    const sid = sealed ? decodeAccessTokenSessionId(sealed.accessToken) : null;
    if (!ready || !sid) return sendJson(res, 200, { ok: true, logoutUrl: null });
    const returnTo = sanitizeReturnPath(
      strField(parseJsonBody(req), "returnTo"),
    );
    return sendJson(res, 200, {
      ok: true,
      logoutUrl: buildWorkosLogoutUrl({
        sessionId: sid,
        returnTo: `${ready.spaOrigin}${returnTo}`,
      }),
    });
  });
};
