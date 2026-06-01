import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { canonicalSignInUrl } from "@/lib/auth-origin";

// WorkOS-hosted login screen. The proxy redirects unauthenticated
// requests to `/sign-in` by default; this route bounces them to the
// WorkOS-hosted sign-in URL (which then redirects back to /callback).
export const GET = async (request: NextRequest) => {
  const canonicalUrl = canonicalSignInUrl({
    requestUrl: request.url,
    redirectUri: process.env["NEXT_PUBLIC_WORKOS_REDIRECT_URI"],
  });
  if (canonicalUrl) {
    redirect(canonicalUrl);
  }

  const signInUrl = await getSignInUrl();
  redirect(signInUrl);
};
