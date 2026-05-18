import { authkitProxy } from "@workos-inc/authkit-nextjs";

// Next.js 16 renamed middleware → proxy. AuthKit's `authkitProxy()`
// manages the encrypted session cookie + redirects unauthenticated
// requests to the WorkOS-hosted sign-in flow.
export default authkitProxy();

// Match everything EXCEPT Next.js's own static asset paths. A catch-
// all matcher would intercept CSS/image responses and break styles.
// The /sign-in route initiates auth itself and /callback completes it;
// both must be reachable while logged-out, so the proxy library treats
// them specially. See AuthKit README.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
