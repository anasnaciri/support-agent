import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { canonicalSignInUrl } from "@/lib/auth-origin";
import { sanitizeReturnTo } from "@/lib/return-to";

// WorkOS-hosted login screen. The proxy redirects unauthenticated
// requests to `/sign-in` by default; this route bounces them to the
// WorkOS-hosted sign-in URL (which then redirects back to /callback).
//
// A `returnTo` query (preserved across the origin canonicalisation) is baked
// into the OAuth state so /callback returns a re-authenticating user to the
// page they were on. Unsafe values fall through to the "/" default.
export const GET = async (request: NextRequest): Promise<void> => {
  const canonicalUrl = canonicalSignInUrl({
    requestUrl: request.url,
    redirectUri: process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"],
  });
  if (canonicalUrl) {
    redirect(canonicalUrl);
  }

  const returnTo = sanitizeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
    "/",
  );
  const signInUrl = await getSignInUrl(
    returnTo === "/" ? undefined : { returnTo },
  );
  redirect(signInUrl);
};
