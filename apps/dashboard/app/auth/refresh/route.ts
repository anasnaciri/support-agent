import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { refreshSession } from "@/lib/session";
import { buildSignUpRedirect } from "@/lib/auth-redirect";
import { sanitizeReturnTo } from "@/lib/return-to";

// ============================================================
// WorkOS session refresh (U1)
// ============================================================
//
// RSCs can't Set-Cookie, so the auth gate (lib/api-client.ts) redirects an
// expired-but-refreshable session here. This route handler CAN write
// cookies: it exchanges the sealed refreshToken for a fresh token pair,
// re-seals the `wos-session` cookie, and bounces straight back to the page
// the user was on — no WorkOS round-trip, no lost form state on the next
// submit. If WorkOS refuses the refresh (revoked/rotated), we fall back to
// the legal-gated /sign-up carrying the same returnTo.
export const GET = async (request: NextRequest): Promise<never> => {
  const returnTo = sanitizeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
    "/",
  );
  const refreshed = await refreshSession();
  if (refreshed?.user) {
    redirect(returnTo);
  }
  redirect(buildSignUpRedirect(returnTo === "/" ? null : returnTo));
};
