// ============================================================
// Google OAuth — code-for-token exchange + userinfo
// ============================================================
//
// The callback handler in `server.ts` calls these two functions
// sequentially: `exchangeCodeForGoogleToken` swaps the `code` from the
// redirect for `{ accessToken, refreshToken, expiresIn, scope }`, then
// `fetchGoogleUserEmail` resolves the mailbox address with that access
// token — we need it as the `shopDomain` discriminator in
// `connector_connections`.

export interface GoogleTokenResponse {
  readonly accessToken: string;
  /** Present on first install (with `prompt=consent`); null on silent re-installs. */
  readonly refreshToken: string | null;
  /** Seconds until access token expiry. */
  readonly expiresInSeconds: number;
  /** Space-separated scope string from Google. */
  readonly scope: ReadonlyArray<string>;
  /** Always `"Bearer"` in practice — surfaced for sanity-check / logging. */
  readonly tokenType: string;
}

export interface ExchangeGoogleCodeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface RawGoogleTokenJson {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export const exchangeCodeForGoogleToken = async (
  opts: ExchangeGoogleCodeOptions,
): Promise<GoogleTokenResponse> => {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as RawGoogleTokenJson;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `google token exchange failed: ${res.status} ${json.error ?? "unknown"}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresInSeconds: json.expires_in ?? 3600,
    scope: (json.scope ?? "").split(/\s+/).filter(Boolean),
    tokenType: json.token_type ?? "Bearer",
  };
};

export interface RefreshGoogleTokenOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Mint a new access token from a stored refresh token. Used by the Gmail
 * connector's HTTP layer when `tokenExpiresAt` has lapsed (and by an
 * eventual retry-on-401 path). Google does not rotate refresh tokens here,
 * so the returned object's `refreshToken` is always null — callers keep
 * the prior refresh token in storage.
 */
export const refreshGoogleAccessToken = async (
  opts: RefreshGoogleTokenOptions,
): Promise<GoogleTokenResponse> => {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as RawGoogleTokenJson;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `google token refresh failed: ${res.status} ${json.error ?? "unknown"}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`,
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: null,
    expiresInSeconds: json.expires_in ?? 3600,
    scope: (json.scope ?? "").split(/\s+/).filter(Boolean),
    tokenType: json.token_type ?? "Bearer",
  };
};

interface RawGoogleUserInfoJson {
  readonly email?: string;
  readonly verified_email?: boolean;
}

export interface FetchGoogleUserEmailOptions {
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolve the mailbox address tied to the access token. Used so the
 * connector_connections row's `shopDomain` reflects the merchant's actual
 * email address (we'd otherwise have nothing to disambiguate between two
 * Gmail accounts under the same tenant).
 */
export const fetchGoogleUserEmail = async (
  opts: FetchGoogleUserEmailOptions,
): Promise<string> => {
  const f = opts.fetchImpl ?? fetch;
  const res = await f("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  const json = (await res.json()) as RawGoogleUserInfoJson;
  if (!res.ok || !json.email) {
    throw new Error(`google userinfo failed: ${res.status}`);
  }
  return json.email;
};
