import "server-only";
import { cookies } from "next/headers";
import { unsealData } from "iron-session";
import {
  getTokenClaims,
  type AccessToken,
  type UserInfo,
} from "@workos-inc/authkit-nextjs";

import { isAccessTokenExpired } from "./session-expiry";

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
// Trade-off vs the proxy: no token refresh on the request path. We honor the
// access token's `exp` and treat an expired token as logged-out so the page
// redirects to re-auth — WorkOS still holds the SSO session, so that's a silent
// round-trip. The cookie-WRITING flows (sign-in, `/callback`, sign-out) are
// unaffected; only the read path moved off the (now-absent) middleware.

/** The shape AuthKit seals into the `wos-session` cookie. */
interface SealedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: UserInfo["user"];
}

/** The subset of `withAuth()`'s result the dashboard actually consumes. */
export interface DashboardSession {
  /** The signed-in WorkOS user, or null when logged-out / expired. */
  readonly user: UserInfo["user"] | null;
  /** The user's active WorkOS organization id, or null. */
  readonly organizationId: string | null;
}

const LOGGED_OUT: DashboardSession = { user: null, organizationId: null };

// AuthKit defaults: cookie `wos-session` unless WORKOS_COOKIE_NAME overrides it.
const cookieName = (): string =>
  process.env["WORKOS_COOKIE_NAME"] || "wos-session";

const cookiePassword = (): string => {
  const p = process.env["WORKOS_COOKIE_PASSWORD"];
  if (!p) throw new Error("WORKOS_COOKIE_PASSWORD is required");
  return p;
};

/**
 * Resolve the current WorkOS session from the cookie. Drop-in replacement for
 * `withAuth()` at the call sites that only need `{ user, organizationId }`.
 * Never throws — any read/unseal failure resolves to logged-out.
 */
export const getSession = async (): Promise<DashboardSession> => {
  let session: SealedSession;
  try {
    const cookie = (await cookies()).get(cookieName());
    if (!cookie?.value) return LOGGED_OUT;
    session = await unsealData<SealedSession>(cookie.value, {
      password: cookiePassword(),
    });
  } catch {
    // Malformed cookie / wrong password → treat as logged-out.
    return LOGGED_OUT;
  }
  if (!session?.accessToken) return LOGGED_OUT;

  const claims = await getTokenClaims<AccessToken>(session.accessToken);
  // No refresh here: once the access token expires, re-authenticate.
  if (isAccessTokenExpired(claims.exp, Date.now())) {
    return LOGGED_OUT;
  }
  return { user: session.user, organizationId: claims.org_id ?? null };
};
