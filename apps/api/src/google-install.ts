// ============================================================
// Google OAuth — pure helpers
// ============================================================
//
// Mirrors `shopify-install.ts`: the install / callback HTTP handlers in
// `server.ts` delegate every signature + URL-shaping decision here so
// they stay unit-testable without a server. State signing is shared with
// Shopify (`shopify-install.ts:signState/verifyState`) — the HMAC scheme
// is provider-neutral.

// ------------------------------------------------------------
// Scopes (the only Google-OAuth strings this app uses)
// ------------------------------------------------------------
//
// We request offline access so Google hands back a refresh token, which
// `ConnectorCredentialStore.patchTokens` rotates the access token from.

export const GOOGLE_GMAIL_SCOPES: ReadonlyArray<string> = [
  // Read message + thread bodies so the agent can quote prior context.
  "https://www.googleapis.com/auth/gmail.readonly",
  // Send replies / askCustomer messages on the merchant's behalf.
  "https://www.googleapis.com/auth/gmail.send",
  // `gmail.modify` is the minimum scope that allows `users.watch` to
  // subscribe to mailbox changes — `gmail.readonly` alone can't.
  "https://www.googleapis.com/auth/gmail.modify",
  // We surface the mailbox address on the connection record so the
  // dashboard can show "connected as you@example.com".
  "https://www.googleapis.com/auth/userinfo.email",
];

// ------------------------------------------------------------
// Authorize URL builder
// ------------------------------------------------------------

export interface GoogleInstallUrlOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** Defaults to the full Gmail scope set above. */
  readonly scopes?: ReadonlyArray<string>;
  /**
   * `prompt=consent` forces Google to re-show the consent screen and
   * return a refresh token even when the merchant has previously granted
   * access. Without it, second installs silently drop the refresh token
   * and we have no way to refresh access tokens after expiry.
   */
  readonly forceConsent?: boolean;
  /** Optional `login_hint` (mailbox address) so Google pre-selects the right account. */
  readonly loginHint?: string;
}

export const buildGoogleAuthorizeUrl = (
  opts: GoogleInstallUrlOptions,
): string => {
  const scopes = opts.scopes ?? GOOGLE_GMAIL_SCOPES;
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    scope: scopes.join(" "),
  });
  if (opts.forceConsent ?? true) {
    params.set("prompt", "consent");
  }
  if (opts.loginHint) {
    params.set("login_hint", opts.loginHint);
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};
