// Pure mapping for a refused install-grant mint (POST /dashboard/connect/
// shopify). The api refuses to mint a grant for a workspace with no app
// credentials of its own — a pilot workspace that isn't provisioned (or was
// revoked), or a deployment with no Shopify app configured at all. The
// resulting code rides the existing `?error=shopify:<code>` banner contract
// on /settings/integrations. Lives in lib/ (not the integrations page dir)
// because the api-client consumes it and lib never imports from app/.

/**
 * Map a refused grant mint onto the `?error=<provider>:<code>` banner
 * contract. Null for anything that isn't a recognized refusal, so callers
 * keep their existing throw-on-unknown path.
 */
export const parseMintDenial = (
  status: number,
  body: unknown,
): string | null => {
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 403 && error === "shopify_provisioning_required") {
    const reason = (body as { reason?: unknown }).reason;
    return reason === "revoked" ? "revoked" : "not_provisioned";
  }
  if (status === 500 && error === "shopify_app_not_configured") {
    return "app_not_configured";
  }
  return null;
};
