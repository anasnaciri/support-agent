// Pure routing/decision logic for WorkOS session refresh (U1). Framework-free
// so it's unit-testable; the cookie/WorkOS glue lives in lib/session.ts and
// the route handler at app/auth/refresh/route.ts.
//
// Background: the middleware-less session read (see lib/session.ts) can't
// refresh on the request path — RSCs cannot Set-Cookie. Instead, an expired
// access token with a sealed refreshToken is "refreshable": the auth gate
// redirects through /auth/refresh (a route handler, which CAN Set-Cookie),
// which performs the WorkOS refresh, re-seals the cookie, and bounces back.

import { sanitizeReturnTo } from "./return-to";

/** Route handler that refreshes the WorkOS session and re-seals the cookie. */
export const REFRESH_PATH = "/auth/refresh";

export type SessionDisposition = "active" | "refreshable" | "logged_out";

/**
 * Classify the sealed session: usable as-is, worth refreshing via the sealed
 * refreshToken, or genuinely logged-out. A missing `exp` counts as active —
 * the iron-session seal already authenticated the cookie.
 */
export const sessionDisposition = (args: {
  readonly hasSession: boolean;
  readonly exp: number | undefined;
  readonly hasRefreshToken: boolean;
  readonly nowMs: number;
}): SessionDisposition => {
  if (!args.hasSession) return "logged_out";
  const expired = typeof args.exp === "number" && args.exp * 1000 <= args.nowMs;
  if (!expired) return "active";
  return args.hasRefreshToken ? "refreshable" : "logged_out";
};

/**
 * The redirect target for an expired-but-refreshable session, carrying the
 * page the user was on as a sanitised `returnTo` so the refresh route can
 * land them back there. Unsafe values collapse to the bare path.
 */
export const buildRefreshRedirect = (
  returnTo: string | null | undefined,
): string => {
  const safe = sanitizeReturnTo(returnTo, "/");
  if (safe === "/") return REFRESH_PATH;
  return `${REFRESH_PATH}?returnTo=${encodeURIComponent(safe)}`;
};
