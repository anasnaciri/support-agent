// ============================================================
// Provider-side OAuth grant revocation
// ============================================================
//
// Wiping a tenant's rows from our DB does NOT tell the providers anything:
// Google/Gmail OAuth grants, the Gmail Pub/Sub watch, and the Shopify app
// install all stay live on the provider side until explicitly revoked. The
// account-deletion cleanup job (apps/worker) calls these to actually sever
// the third-party access. See pre-onboarding audit B1.
//
// Every function is BEST-EFFORT: it never throws, and an "already invalid"
// response from the provider (the grant we wanted gone is already gone) is a
// success, not a failure. Plain HTTP with injectable fetch, no Effect — the
// caller maps the structured outcome.

import { stopGmailWatch } from "./gmail-watch.js";

export type RevocableProvider = "shopify" | "gmail" | "google_sheets";

/** A connector grant to revoke provider-side. Tokens are plaintext here —
 * the worker decrypts them from the job payload just before calling. */
export interface ConnectorGrant {
  readonly provider: RevocableProvider;
  /** Shop domain (Shopify) or mailbox/account label (Google). */
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Shopify Admin API version for the uninstall endpoint; null → default. */
  readonly apiVersion: string | null;
}

export type RevocationOutcome =
  /** Provider acknowledged the revoke (2xx). */
  | { readonly kind: "revoked" }
  /** Provider says the token/install is already invalid — nothing to do. */
  | { readonly kind: "already_gone" }
  /** Transient/unexpected failure — the grant may still be live. */
  | { readonly kind: "failed"; readonly detail: string };

const DEFAULT_SHOPIFY_API_VERSION = "2026-04";

/**
 * Revoke a Google OAuth token (access OR refresh). Revoking a refresh token
 * invalidates the whole grant and every derived access token, so callers
 * should prefer the refresh token when they have one.
 */
export const revokeGoogleOAuthToken = async (
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RevocationOutcome> => {
  try {
    const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
    });
    if (res.ok) return { kind: "revoked" };
    // Google returns 400 when the token is already invalid/expired.
    if (res.status === 400) return { kind: "already_gone" };
    return { kind: "failed", detail: `google revoke status ${res.status}` };
  } catch (cause) {
    return { kind: "failed", detail: `google revoke threw: ${String(cause)}` };
  }
};

export interface UninstallShopifyAppInput {
  readonly shopDomain: string;
  readonly accessToken: string;
  readonly apiVersion: string | null;
}

/**
 * Uninstall a Shopify app for a shop by revoking the access token
 * (`DELETE /admin/api/<ver>/api_permissions/current.json`). This is the
 * documented way for an app to remove its own grant.
 */
export const uninstallShopifyApp = async (
  input: UninstallShopifyAppInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RevocationOutcome> => {
  const version = input.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION;
  try {
    const res = await fetchImpl(
      `https://${input.shopDomain}/admin/api/${version}/api_permissions/current.json`,
      {
        method: "DELETE",
        headers: { "X-Shopify-Access-Token": input.accessToken },
      },
    );
    if (res.ok) return { kind: "revoked" };
    // 401/403 → token already invalid; 404 → nothing installed.
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { kind: "already_gone" };
    }
    return { kind: "failed", detail: `shopify uninstall status ${res.status}` };
  } catch (cause) {
    return {
      kind: "failed",
      detail: `shopify uninstall threw: ${String(cause)}`,
    };
  }
};

/**
 * Revoke one connector grant provider-side, dispatching on provider:
 *   - shopify       → uninstall (revoke the access token)
 *   - gmail         → stop the Pub/Sub watch, then revoke the OAuth grant
 *   - google_sheets → revoke the OAuth grant
 *
 * Best-effort and never throws. Google revocation prefers the refresh token
 * so the entire grant dies, falling back to the access token.
 */
export const revokeConnectorGrant = async (
  grant: ConnectorGrant,
  fetchImpl: typeof fetch = fetch,
): Promise<RevocationOutcome> => {
  switch (grant.provider) {
    case "shopify":
      return uninstallShopifyApp(
        {
          shopDomain: grant.shopDomain,
          accessToken: grant.accessToken,
          apiVersion: grant.apiVersion,
        },
        fetchImpl,
      );
    case "gmail": {
      // Stop the watch first (needs a still-valid access token), then revoke
      // the grant. The watch-stop result is auxiliary — the grant revoke is
      // the authoritative outcome.
      await stopGmailWatch(grant.accessToken, fetchImpl);
      return revokeGoogleOAuthToken(
        grant.refreshToken ?? grant.accessToken,
        fetchImpl,
      );
    }
    case "google_sheets":
      return revokeGoogleOAuthToken(
        grant.refreshToken ?? grant.accessToken,
        fetchImpl,
      );
  }
};
