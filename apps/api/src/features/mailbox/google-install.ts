// ============================================================
// Google OAuth — pure helpers
// ============================================================
//
// Mirrors `shopify-install.ts`: the install / callback HTTP handlers in
// `server.ts` delegate every signature + URL-shaping decision here so
// they stay unit-testable without a server. Google state also carries the
// connector provider because Gmail and Sheets share the OAuth callback.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

export const GOOGLE_SHEETS_SCOPES: ReadonlyArray<string> = [
  // Read/write spreadsheets through the Sheets API.
  "https://www.googleapis.com/auth/spreadsheets",
  // Surface the connected Google account on the connection record.
  "https://www.googleapis.com/auth/userinfo.email",
];

export type GoogleOAuthProvider = "gmail" | "google_sheets";

export const GOOGLE_OAUTH_SCOPES: Readonly<
  Record<GoogleOAuthProvider, ReadonlyArray<string>>
> = {
  gmail: GOOGLE_GMAIL_SCOPES,
  google_sheets: GOOGLE_SHEETS_SCOPES,
};

export const isGoogleOAuthProvider = (
  value: string | undefined,
): value is GoogleOAuthProvider =>
  value === "gmail" || value === "google_sheets";

export const googleScopesForProvider = (
  provider: GoogleOAuthProvider,
): ReadonlyArray<string> => GOOGLE_OAUTH_SCOPES[provider];

// ------------------------------------------------------------
// State signing
// ------------------------------------------------------------

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

export interface GoogleInstallStatePayload {
  readonly tenantId: string;
  readonly provider: GoogleOAuthProvider;
  readonly nonce: string;
}

export const signGoogleInstallState = (
  signingKey: string,
  input: {
    readonly tenantId: string;
    readonly provider: GoogleOAuthProvider;
    readonly nonce?: string;
  },
): string => {
  const payload = JSON.stringify({
    tenantId: input.tenantId,
    provider: input.provider,
    nonce: input.nonce ?? b64url(randomBytes(16)),
  });
  const encodedPayload = b64url(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", signingKey).update(payload).digest();
  return `${encodedPayload}.${b64url(sig)}`;
};

export const verifyGoogleInstallState = (
  signingKey: string,
  state: string,
): GoogleInstallStatePayload | null => {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = fromB64url(encodedPayload);
    sig = fromB64url(encodedSig);
  } catch {
    return null;
  }

  const payload = payloadBytes.toString("utf8");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["tenantId"] !== "string" || !candidate["tenantId"]) {
    return null;
  }
  if (
    typeof candidate["provider"] !== "string" ||
    !isGoogleOAuthProvider(candidate["provider"])
  ) {
    return null;
  }
  if (typeof candidate["nonce"] !== "string" || !candidate["nonce"]) {
    return null;
  }
  return {
    tenantId: candidate["tenantId"],
    provider: candidate["provider"],
    nonce: candidate["nonce"],
  };
};

// ------------------------------------------------------------
// Authorize URL builder
// ------------------------------------------------------------

export interface GoogleInstallUrlOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** Defaults to Gmail for backwards-compatible callers. */
  readonly provider?: GoogleOAuthProvider;
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
  const scopes =
    opts.scopes ?? googleScopesForProvider(opts.provider ?? "gmail");
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
