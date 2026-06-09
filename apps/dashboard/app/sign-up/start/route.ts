import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { sanitizeReturnTo } from "@/lib/return-to";

// Keep AuthKit's PKCE-cookie write in a GET route. OpenNext propagates its
// Set-Cookie header here before redirecting the browser to WorkOS.
//
// `returnTo` is the page the user was on when their session lapsed (threaded
// from the gate → /sign-up form → here). WorkOS bakes it into the signed OAuth
// state and /callback redirects there after auth. A brand-new sign-up has no
// returnTo, so we default to /onboarding (the tenant-provisioning step).
export const GET = async (request: NextRequest): Promise<void> => {
  const returnTo = sanitizeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
    "/onboarding",
  );
  redirect(await getSignUpUrl({ returnTo }));
};
