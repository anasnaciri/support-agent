import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { api, getDashboardContext } from "@/lib/api-client";

// GET /connect/:provider — the Connect/Reconnect button target. Authenticates
// the merchant via their WorkOS session (getDashboardContext redirects to
// /sign-up when logged out and resolves the tenant from the session), has the
// api mint a short-lived signed install grant for THAT tenant, then redirects
// the browser to the provider OAuth. The tenant is never client-supplied, so
// one merchant can't start an install that binds a provider account to another
// tenant (5th-audit #2).

const SUPPORTED = new Set(["shopify", "gmail", "google_sheets"]);

export const GET = async (
  _request: Request,
  { params }: { readonly params: Promise<{ readonly provider: string }> },
): Promise<never> => {
  const { provider } = await params;
  if (!SUPPORTED.has(provider)) redirect("/settings/integrations");

  const ctx = await getDashboardContext();
  const { user } = await getSession();
  const { url } = await api.connectUrl(ctx, provider);

  // Prefill the Google account on the consent screen (UX only; Shopify uses
  // the shop, not a login hint).
  const hint =
    provider !== "shopify" && user?.email
      ? `&login_hint=${encodeURIComponent(user.email)}`
      : "";
  redirect(`${url}${hint}`);
};
