// Pure parsing for the connect outcome banners (U6). The apps/api OAuth
// callback redirects back to /settings/integrations with
// `?error=<provider>:<code>` when the merchant cancels consent or the
// callback fails (e.g. `gmail:access_denied`, `outlook:exchange_failed`),
// and with `?connected=<provider>` on success. Framework-free so it's
// unit-testable.

import type { ShopifyAppGateView } from "@support-agent/dashboard-contracts";

import { PROVIDER_LABELS } from "./integration-providers";

export interface ConnectError {
  readonly provider: string;
  readonly code: string;
}

/**
 * Parse `<provider>:<code>` into its parts. Returns null for anything that
 * doesn't match the contract — including the legacy bare `already_connected`
 * code (rendered by its own banner) and unknown providers, so arbitrary query
 * text is never echoed into the page.
 */
export const parseConnectError = (
  raw: string | undefined,
): ConnectError | null => {
  if (!raw) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const provider = raw.slice(0, colon);
  const code = raw.slice(colon + 1);
  if (!code) return null;
  if (!(provider in PROVIDER_LABELS)) return null;
  return { provider, code };
};

/** Friendly copy per failure code, with a generic fallback. */
export const connectErrorMessage = (code: string): string => {
  switch (code.split(":")[0]) {
    case "access_denied":
      return "The connection was cancelled on the provider's consent screen. Nothing was connected. Click Connect to try again.";
    case "exchange_failed":
      return "The provider accepted the connection but the token exchange failed. Please try connecting again.";
    case "state_mismatch":
    case "invalid_state":
      return "The connect link had expired or was already used. Start the connection again from this page.";
    case "not_provisioned":
    case "revoked":
      return "This workspace doesn't have its own Shopify app yet. Support is setting it up. You can connect once it's ready.";
    case "app_not_configured":
      return "Shopify connections aren't available yet. Please contact support.";
    default:
      return "Something went wrong completing the connection. Nothing was connected. Please try again.";
  }
};

/**
 * Connect-button state for the Shopify card. `available` is the api's own
 * install/grant gate (resolved per workspace, fallbacks included or refused
 * exactly as the install endpoint would) — when it's false the button is
 * disabled and the other gate fields only pick which explanation renders:
 * a pilot workspace waiting on operator provisioning vs a deployment that
 * ships no Shopify app at all.
 */
export type ShopifyConnectState =
  | "available"
  | "awaiting_provisioning"
  | "unconfigured";

export const shopifyConnectState = (
  gate: ShopifyAppGateView,
): ShopifyConnectState =>
  gate.available
    ? "available"
    : gate.requiresProvisioning
      ? "awaiting_provisioning"
      : "unconfigured";

/**
 * What the `?connected=<provider>` redirect breadcrumb may claim. The success
 * banner is only rendered when THIS workspace actually holds an active
 * connection for the provider — a connect that completed against another
 * workspace (or didn't persist) must surface as a warning, never "connected."
 */
export type ConnectedBanner =
  | { readonly kind: "connected"; readonly label: string }
  | { readonly kind: "not_landed"; readonly label: string };

export const connectedBanner = (
  connectedParam: string | undefined,
  rowStatus: string | undefined,
): ConnectedBanner | null => {
  if (!connectedParam) return null;
  const label = PROVIDER_LABELS[connectedParam];
  if (!label) return null;
  return rowStatus === "active"
    ? { kind: "connected", label }
    : { kind: "not_landed", label };
};
