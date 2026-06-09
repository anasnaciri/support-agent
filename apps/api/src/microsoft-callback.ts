// ============================================================
// Microsoft (Graph / Outlook) OAuth — code-for-token + userinfo
// ============================================================
//
// Mirrors `google-callback.ts`. The callback handler in `server.ts` calls
// `exchangeCodeForMicrosoftToken` to swap the redirect `code` for tokens, then
// `fetchMicrosoftUserEmail` to resolve the mailbox address (the `shopDomain`
// discriminator in `connector_connections`). The connector's own refresh path
// lives in `packages/providers/graph-token.ts`.

import { MICROSOFT_OUTLOOK_SCOPES } from "./microsoft-install.js";

export interface MicrosoftTokenResponse {
  readonly accessToken: string;
  /** Microsoft issues (and rotates) a refresh token when `offline_access` is granted. */
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
  readonly scope: ReadonlyArray<string>;
  readonly tokenType: string;
}

export interface ExchangeMicrosoftCodeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly code: string;
  /** Azure AD tenant segment. Defaults to "common". */
  readonly tenant?: string;
  readonly fetchImpl?: typeof fetch;
}

interface RawTokenJson {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
  readonly error?: string;
  readonly error_description?: string;
}

export const exchangeCodeForMicrosoftToken = async (
  opts: ExchangeMicrosoftCodeOptions,
): Promise<MicrosoftTokenResponse> => {
  const f = opts.fetchImpl ?? fetch;
  const tenant = opts.tenant ?? "common";
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    scope: MICROSOFT_OUTLOOK_SCOPES.join(" "),
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
      `microsoft token exchange failed: ${res.status} ${json.error ?? "unknown"}${
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

interface RawGraphMeJson {
  readonly mail?: string | null;
  readonly userPrincipalName?: string | null;
}

export interface FetchMicrosoftUserEmailOptions {
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolve the mailbox address tied to the access token via Graph `/me`. Prefer
 * `mail`; fall back to `userPrincipalName` (some accounts expose only the UPN).
 */
export const fetchMicrosoftUserEmail = async (
  opts: FetchMicrosoftUserEmailOptions,
): Promise<string> => {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    { headers: { Authorization: `Bearer ${opts.accessToken}` } },
  );
  const json = (await res.json()) as RawGraphMeJson;
  const email = json.mail ?? json.userPrincipalName ?? null;
  if (!res.ok || !email) {
    throw new Error(`microsoft userinfo failed: ${res.status}`);
  }
  return email;
};
