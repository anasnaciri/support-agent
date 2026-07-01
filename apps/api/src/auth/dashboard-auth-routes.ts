import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteContext } from "../platform/context.js";
import { sendJson } from "../platform/http.js";
import { dashboardUserDecisionUuid } from "./dashboard-user-id.js";
import {
  getDashboardSessionCodec,
  getDashboardVerifier,
} from "./dashboard-context.js";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE_NAME,
  buildAuthorizeUrl,
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
} from "./dashboard-session.js";

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
    if (!verified.ok && verified.reason === "expired" && sealed.refreshToken) {
      const refreshed = await refreshAccessToken({
        clientId: ready.clientId,
        apiKey: ready.apiKey,
        refreshToken: sealed.refreshToken,
        ...fetchOpt,
      });
      if (refreshed.ok) {
        sealed = refreshed.session;
        res.header(
          "set-cookie",
          serializeSessionCookie(await ready.codec.seal(sealed), { secure }),
        );
        verified = await verifier.verify(sealed.accessToken);
      }
    }
    if (!verified.ok) return sendJson(res, 401, { error: "unauthenticated" });
    return sendJson(res, 200, {
      organizationId: verified.claims.organizationId,
      userId: dashboardUserDecisionUuid(verified.claims.workosUserId),
      user: sealed.user,
    });
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

  // ---- Logout: clear the session cookie (POST-only, mirrors S13) ----
  app.post("/dashboard/auth/logout", schema, async (_req, res) => {
    res.header("set-cookie", serializeSessionClearCookie({ secure }));
    return sendJson(res, 200, { ok: true });
  });
};
