import "server-only";
import { cookies } from "next/headers";
import { sealData, unsealData } from "iron-session";
import {
  getTokenClaims,
  getWorkOS,
  type AccessToken,
  type UserInfo,
} from "@workos-inc/authkit-nextjs";

import { isAccessTokenExpired } from "./session-expiry";
import { sessionDisposition, type SessionDisposition } from "./session-refresh";

// ============================================================
// Middleware-less WorkOS session read (Cloudflare Workers / OpenNext)
// ============================================================
//
// The dashboard deploys to Cloudflare Workers via OpenNext, which rejects
// Next 16's proxy (middleware) — Next 16 makes the proxy Node-only and refuses
// `runtime: "edge"`, and OpenNext only builds with an edge middleware or none.
// AuthKit's `withAuth()` requires that proxy (it throws unless the proxy
// injected its `x-workos-middleware` session header), so we can't use it.
//
// Instead we read the WorkOS session straight from its cookie. AuthKit seals
// the session with `iron-session` under `WORKOS_COOKIE_PASSWORD` (the same
// library + cookie name it uses internally), so unsealing here authenticates
// it exactly as AuthKit would — a tampered/foreign cookie fails to unseal and
// is treated as logged-out. (AuthKit's own `getSessionFromCookie` is not a
// public export, so we replicate it; `getTokenClaims` IS public and decodes
// the embedded access-token JWT for `org_id`.)
//
// Trade-off vs the proxy: no token refresh on the RSC request path — an RSC
// cannot Set-Cookie. Instead (U1) the sealed `refreshToken` IS used, from the
// places that can write cookies:
//   - route handlers (`/auth/refresh`, the poll proxies under /api/cases)
//     call `refreshSession()` / `getSessionOrRefresh()` below, which exchange
//     the refresh token with WorkOS, re-seal, and Set-Cookie;
//   - the RSC auth gate (lib/api-client.ts) classifies an expired-but-
//     refreshable session via `getSessionState()` and redirects through
//     `/auth/refresh?returnTo=…` rather than dumping the user on /sign-up.
// Only when the refresh token is absent or the exchange fails do we fall back
// to full re-auth. The cookie-WRITING auth flows (sign-in, `/callback`,
// sign-out) are unaffected; only the read path moved off the (absent)
// middleware.

/** The shape AuthKit seals into the `wos-session` cookie. */
interface SealedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: UserInfo["user"];
  /** Present when the session was minted via WorkOS impersonation. */
  readonly impersonator?: unknown;
}

/** The subset of `withAuth()`'s result the dashboard actually consumes. */
export interface DashboardSession {
  /** The signed-in WorkOS user, or null when logged-out / expired. */
  readonly user: UserInfo["user"] | null;
  /** The user's active WorkOS organization id, or null. */
  readonly organizationId: string | null;
  /**
   * The raw WorkOS access token (the RS256 JWT). Forwarded to apps/api as the
   * `Authorization: Bearer` credential (S14): the api verifies it and reads the
   * org/user from its claims. `null` when logged-out / expired.
   */
  readonly accessToken: string | null;
}

const LOGGED_OUT: DashboardSession = {
  user: null,
  organizationId: null,
  accessToken: null,
};

// AuthKit defaults: cookie `wos-session` unless WORKOS_COOKIE_NAME overrides it.
const cookieName = (): string =>
  process.env["WORKOS_COOKIE_NAME"] || "wos-session";

const cookiePassword = (): string => {
  const p = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!p) throw new Error("WORKOS_COOKIE_PASSWORD is required");
  return p;
};

/** Unseal the cookie, or null on absence / tamper / wrong password. */
const readSealedSession = async (): Promise<SealedSession | null> => {
  try {
    const cookie = (await cookies()).get(cookieName());
    if (!cookie?.value) return null;
    const session = await unsealData<SealedSession>(cookie.value, {
      password: cookiePassword(),
    });
    return session?.accessToken ? session : null;
  } catch {
    return null;
  }
};

/**
 * Resolve the current WorkOS session from the cookie. Drop-in replacement for
 * `withAuth()` at the call sites that only need `{ user, organizationId }`.
 * Never throws — any read/unseal failure resolves to logged-out. An expired
 * access token also resolves to logged-out; callers that can act on
 * "refreshable" use `getSessionState()` / `getSessionOrRefresh()` instead.
 */
export const getSession = async (): Promise<DashboardSession> => {
  const session = await readSealedSession();
  if (!session) return LOGGED_OUT;

  const claims = await getTokenClaims<AccessToken>(session.accessToken);
  if (isAccessTokenExpired(claims.exp, Date.now())) {
    return LOGGED_OUT;
  }
  return {
    user: session.user,
    organizationId: claims.org_id ?? null,
    accessToken: session.accessToken,
  };
};

export interface SessionState {
  readonly disposition: SessionDisposition;
  /** Resolved session — `user` is null unless disposition is "active". */
  readonly session: DashboardSession;
}

/**
 * Like `getSession()`, but distinguishes "expired with a sealed refreshToken"
 * (→ `refreshable`) from genuinely logged-out, so the RSC auth gate can route
 * the request through `/auth/refresh` instead of forcing a full re-auth.
 */
export const getSessionState = async (): Promise<SessionState> => {
  const session = await readSealedSession();
  if (!session) return { disposition: "logged_out", session: LOGGED_OUT };

  const claims = await getTokenClaims<AccessToken>(session.accessToken);
  const disposition = sessionDisposition({
    hasSession: true,
    exp: claims.exp,
    hasRefreshToken: Boolean(session.refreshToken),
    nowMs: Date.now(),
  });
  if (disposition !== "active") return { disposition, session: LOGGED_OUT };
  return {
    disposition,
    session: {
      user: session.user,
      organizationId: claims.org_id ?? null,
      accessToken: session.accessToken,
    },
  };
};

// Cookie attributes mirroring AuthKit's own (`getCookieOptions`): 400-day
// cookie lifetime by default — the access/refresh tokens inside are the
// actual time-limited element — `secure` derived from the redirect URI's
// scheme, SameSite/domain/name from the same env vars AuthKit reads.
const cookieWriteOptions = () => {
  const redirectUri = process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"];
  let secure = true;
  if (redirectUri) {
    try {
      secure = new URL(redirectUri).protocol === "https:";
    } catch {
      secure = true;
    }
  }
  const maxAgeRaw = process.env["WORKOS_COOKIE_MAX_AGE"];
  const parsed = maxAgeRaw ? Number.parseInt(maxAgeRaw, 10) : Number.NaN;
  const maxAge = Number.isFinite(parsed) ? parsed : 60 * 60 * 24 * 400;
  const sameSiteRaw = (
    process.env["WORKOS_COOKIE_SAMESITE"] || "lax"
  ).toLowerCase();
  const sameSite =
    sameSiteRaw === "strict" || sameSiteRaw === "none"
      ? (sameSiteRaw as "strict" | "none")
      : ("lax" as const);
  const domain = process.env["WORKOS_COOKIE_DOMAIN"];
  return {
    path: "/",
    httpOnly: true,
    secure,
    sameSite,
    maxAge,
    ...(domain ? { domain } : {}),
  };
};

/**
 * Exchange the sealed refreshToken for a fresh WorkOS token pair, re-seal the
 * session, and Set-Cookie. MUST only be called from a route handler or server
 * action — RSCs cannot write cookies. Returns the refreshed session, or null
 * when there's nothing to refresh / WorkOS refuses (revoked, rotated, …);
 * the caller then falls back to full re-auth.
 */
export const refreshSession = async (): Promise<DashboardSession | null> => {
  const session = await readSealedSession();
  if (!session?.refreshToken) return null;

  const clientId = process.env["WORKOS_CLIENT_ID"];
  if (!clientId) return null;

  try {
    const oldClaims = await getTokenClaims<AccessToken>(session.accessToken);
    const refreshed = await getWorkOS().userManagement.authenticateWithRefreshToken(
      {
        clientId,
        refreshToken: session.refreshToken,
        ...(oldClaims.org_id ? { organizationId: oldClaims.org_id } : {}),
      },
    );

    const sealed = await sealData(
      {
        ...session,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        user: refreshed.user,
        impersonator: refreshed.impersonator,
      },
      // ttl 0 = no iron-session expiry — matches AuthKit's encryptSession.
      { password: cookiePassword(), ttl: 0 },
    );
    (await cookies()).set(cookieName(), sealed, cookieWriteOptions());

    const claims = await getTokenClaims<AccessToken>(refreshed.accessToken);
    return {
      user: refreshed.user,
      organizationId: claims.org_id ?? null,
      accessToken: refreshed.accessToken,
    };
  } catch {
    // Revoked / already-rotated refresh token, network failure, … → the
    // caller treats this as logged-out and forces a real re-auth.
    return null;
  }
};

/**
 * For route handlers (the /api/cases poll proxies): the active session, or —
 * when the access token has lapsed mid-poll — a refresh attempt before giving
 * up. Keeps an open dashboard tab's session alive instead of letting the
 * pollers decay into permanent 401s.
 */
export const getSessionOrRefresh = async (): Promise<DashboardSession> => {
  const state = await getSessionState();
  if (state.disposition === "active") return state.session;
  if (state.disposition === "refreshable") {
    return (await refreshSession()) ?? LOGGED_OUT;
  }
  return LOGGED_OUT;
};
