// ============================================================
// Post-connect redirect target
// ============================================================
//
// After a successful connector OAuth callback we want the merchant to
// land back inside our own app — the dashboard's integrations page —
// the same way Claude returns you to its connectors page after a
// connect. That page already renders the now-active connection, so it
// doubles as the "you're connected, here's how to configure it" screen.
//
// The dashboard origin is configured separately from apps/api (they may
// be deployed on different hosts), so when it isn't set we fall back to
// the standalone `/installed` landing page served by apps/api. Returning
// `null` here lets the caller keep its existing `/installed` query
// construction unchanged for the fallback path.

export interface DashboardRedirectExtra {
  /** Shopify shop domain, surfaced on the integrations page. */
  readonly shop?: string | null;
}

export const dashboardConnectRedirect = (
  dashboardBaseUrl: string | null,
  provider: string,
  extra?: DashboardRedirectExtra,
): string | null => {
  if (!dashboardBaseUrl) return null;
  // Join as a string (not `new URL(path, base)`) so a base URL carrying a
  // path prefix — e.g. https://example.com/app — is preserved rather than
  // reset by a leading-slash pathname.
  const trimmed = dashboardBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(`${trimmed}/settings/integrations`);
    url.searchParams.set("connected", provider);
    if (extra?.shop) url.searchParams.set("shop", extra.shop);
    return url.toString();
  } catch {
    return null;
  }
};
