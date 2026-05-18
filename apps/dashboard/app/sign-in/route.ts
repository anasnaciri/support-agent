import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

// WorkOS-hosted login screen. The proxy redirects unauthenticated
// requests to `/sign-in` by default; this route bounces them to the
// WorkOS-hosted sign-in URL (which then redirects back to /callback).
export const GET = async () => {
  const signInUrl = await getSignInUrl();
  redirect(signInUrl);
};
