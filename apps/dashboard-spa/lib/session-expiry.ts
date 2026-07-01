// Pure helper, free of `server-only`/next imports so it's unit-testable — the
// session-reading glue in lib/session.ts can't be (server-only + cookies()).

/**
 * Whether a WorkOS access token with this `exp` (seconds since epoch) should be
 * treated as expired at `nowMs` (ms since epoch). Used by the middleware-less
 * session read to force re-auth once the token lapses (there's no proxy to
 * refresh it on the Cloudflare/OpenNext deploy — see lib/session.ts).
 *
 * A missing `exp` is treated as NOT expired: the iron-session seal already
 * authenticated the cookie, so we'd rather trust it than log everyone out if
 * the claim is ever absent.
 */
export const isAccessTokenExpired = (
  exp: number | undefined,
  nowMs: number,
): boolean => typeof exp === "number" && exp * 1000 <= nowMs;
