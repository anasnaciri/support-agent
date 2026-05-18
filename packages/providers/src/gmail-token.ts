// ============================================================
// Google OAuth refresh — used inside the Gmail connector
// ============================================================
//
// Mirrors `apps/api/src/google-callback.ts:refreshGoogleAccessToken` but
// lives here so `packages/providers` can mint fresh access tokens without
// reaching into an app package. The implementations stay in lockstep.

export interface RefreshGmailTokenOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RefreshedGmailToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

interface RawTokenJson {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

export const refreshGmailToken = async (
  opts: RefreshGmailTokenOptions,
): Promise<RefreshedGmailToken> => {
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
  const json = (await res.json()) as RawTokenJson;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `gmail token refresh failed: ${res.status} ${json.error ?? "unknown"}${
        json.error_description ? ` — ${json.error_description}` : ""
      }`,
    );
  }
  const expiresInSeconds = json.expires_in ?? 3600;
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
};
