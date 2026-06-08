import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

// Keep AuthKit's PKCE-cookie write in a GET route. OpenNext propagates its
// Set-Cookie header here before redirecting the browser to WorkOS.
export const GET = async () => {
  redirect(await getSignUpUrl({ returnTo: "/onboarding" }));
};
