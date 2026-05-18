import { handleAuth } from "@workos-inc/authkit-nextjs";

// WorkOS redirects the browser here after a successful sign-in. The
// helper finishes the PKCE/CSRF handshake, mints the encrypted session
// cookie, then redirects to `returnPathname`. The redirect URL on the
// WorkOS dashboard must point at this route — see .env.example.
export const GET = handleAuth({ returnPathname: "/" });
