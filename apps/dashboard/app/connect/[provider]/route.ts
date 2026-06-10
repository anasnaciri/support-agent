import { redirect } from "next/navigation";

import { api, getDashboardContext } from "@/lib/api-client";
import { connectRedirectUrl } from "@/lib/connect-redirect";

// GET /connect/:provider — the Connect/Reconnect button target. Authenticates
// the merchant via their WorkOS session (getDashboardContext redirects to
// /sign-up when logged out and resolves the tenant from the session), has the
// api mint a short-lived signed install grant for THAT tenant, then redirects
// the browser to the provider OAuth. The tenant is never client-supplied, so
// one merchant can't start an install that binds a provider account to another
// tenant (5th-audit #2).

// OAuth-redirect connectors only. `imap` is intentionally absent — it has no
// OAuth flow and is connected through the /connect/imap credential form.
const SUPPORTED = new Set(["shopify", "gmail", "google_sheets", "outlook"]);

export const GET = async (
  _request: Request,
  { params }: { readonly params: Promise<{ readonly provider: string }> },
): Promise<never> => {
  const { provider } = await params;
  if (!SUPPORTED.has(provider)) redirect("/settings/integrations");

  const ctx = await getDashboardContext();
  const result = await api.connectUrl(ctx, provider);

  // One mailbox per provider per store: the api refuses to start the OAuth
  // flow while one is connected. Land back on integrations with the
  // conflict spelled out instead of the provider's consent screen.
  if ("alreadyConnected" in result) {
    const qs = new URLSearchParams({
      error: "already_connected",
      provider,
    });
    if (result.alreadyConnected.mailbox) {
      qs.set("mailbox", result.alreadyConnected.mailbox);
    }
    redirect(`/settings/integrations?${qs.toString()}`);
  }

  // No `login_hint`: the dashboard login email is the merchant's account, not
  // the mailbox they're connecting. Prefilling it pre-selected (and on
  // Microsoft, locked) the wrong account. The user picks the account on the
  // provider's own screen. See lib/connect-redirect.ts.
  redirect(connectRedirectUrl(result.url, provider, null));
};
