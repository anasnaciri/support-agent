// ============================================================
// Shopify code → access_token exchange
// ============================================================

export interface AccessTokenExchangeOptions {
  readonly shop: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  /** Override for tests. Defaults to native fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface ShopifyAccessTokenResponse {
  readonly accessToken: string;
  readonly scope: ReadonlyArray<string>;
}

export class AccessTokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenExchangeError";
  }
}

/**
 * Exchange an OAuth `code` for an offline access token. Shopify returns
 * `{ access_token, scope }` where `scope` is a comma-delimited list of
 * granted scopes — we split it to an array to make downstream filtering
 * easy.
 *
 * Throws `AccessTokenExchangeError` on non-2xx responses or shapes the
 * code can't recognise. The caller surfaces this to the merchant as a
 * 4xx, not a 500.
 */
export const exchangeCodeForToken = async (
  opts: AccessTokenExchangeOptions,
): Promise<ShopifyAccessTokenResponse> => {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `https://${opts.shop}/admin/oauth/access_token`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AccessTokenExchangeError(
      `Shopify access_token exchange failed: ${res.status} ${body}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: unknown;
    scope?: unknown;
  };
  if (typeof json.access_token !== "string") {
    throw new AccessTokenExchangeError(
      "access_token missing in Shopify response",
    );
  }
  const scope =
    typeof json.scope === "string"
      ? json.scope.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  return {
    accessToken: json.access_token,
    scope,
  };
};
