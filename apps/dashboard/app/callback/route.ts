import { cookies } from "next/headers";
import { getWorkOS, handleAuth } from "@workos-inc/authkit-nextjs";

import {
  LEGAL_CONSENT_COOKIE,
  buildAcceptanceMetadata,
} from "@/lib/legal-consent";

// WorkOS redirects the browser here after a successful sign-in. The helper
// finishes the PKCE/CSRF handshake, mints the encrypted session cookie, then
// redirects to `returnPathname` (overridden per-request by the sign-up flow's
// `returnTo`). The redirect URL on the WorkOS dashboard must point at this
// route — see .env.example.
//
// `onSuccess` records legal acceptance for users who came through our
// self-hosted /sign-up page: that page sets a short-lived `legal_consent`
// cookie before the Google handoff, and here we stamp the acceptance timestamp
// onto the WorkOS user's metadata. Returning users (hosted sign-in, no cookie)
// are left untouched.
export const GET = handleAuth({
  returnPathname: "/",
  onSuccess: async ({ user }) => {
    const c = await cookies();
    if (!c.get(LEGAL_CONSENT_COOKIE)) return;
    await getWorkOS().userManagement.updateUser({
      userId: user.id,
      metadata: buildAcceptanceMetadata(user.metadata ?? {}, new Date()),
    });
    c.delete(LEGAL_CONSENT_COOKIE);
  },
});
