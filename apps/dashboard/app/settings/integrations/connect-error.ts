// Pure parsing for the OAuth-failure banner contract (U6). The apps/api OAuth
// callback redirects back to /settings/integrations with
// `?error=<provider>:<code>` when the merchant cancels consent or the
// callback fails (e.g. `gmail:access_denied`, `outlook:exchange_failed`).
// Framework-free so it's unit-testable.

import { PROVIDER_LABELS } from "./_shared";

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
      return "The connection was cancelled on the provider's consent screen. Nothing was connected — click Connect to try again.";
    case "exchange_failed":
      return "The provider accepted the connection but the token exchange failed. Please try connecting again.";
    case "state_mismatch":
    case "invalid_state":
      return "The connect link had expired or was already used. Start the connection again from this page.";
    default:
      return "Something went wrong completing the connection. Nothing was connected — please try again.";
  }
};
