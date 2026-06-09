// ============================================================
// Microsoft identity platform OAuth refresh — Graph connector
// ============================================================
//
// Mirrors `gmail-token.ts` but hits the Microsoft identity token endpoint.
// One important difference from Google: Microsoft ROTATES the refresh token
// on every refresh, so the caller MUST persist the returned `refreshToken`
// (when present) or the next refresh will fail with `invalid_grant`.

export interface RefreshGraphTokenOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Azure AD tenant for the token endpoint. Defaults to "common". */
  readonly tenant?: string;
  /** OAuth scopes to request. Defaults to the mail read/send + offline set. */
  readonly scope?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RefreshedGraphToken {
  readonly accessToken: string;
  /**
   * The rotated refresh token. `null` when the endpoint did not return a new
   * one (the caller should then keep the existing token).
   */
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
}

interface RawTokenJson {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

/** Default delegated scopes — kept in lockstep with `microsoft-install.ts`. */
export const GRAPH_MAIL_SCOPES =
  "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access openid email profile";

export const refreshGraphToken = async (
  opts: RefreshGraphTokenOptions,
): Promise<RefreshedGraphToken> => {
  const f = opts.fetchImpl ?? fetch;
  const tenant = opts.tenant ?? "common";
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
    scope: opts.scope ?? GRAPH_MAIL_SCOPES,
  });
  const res = await f(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const json = (await res.json()) as RawTokenJson;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `graph token refresh failed: ${res.status} ${json.error ?? "unknown"}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`,
    );
  }
  const expiresInSeconds = json.expires_in ?? 3600;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
};
