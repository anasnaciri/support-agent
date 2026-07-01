import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

// ============================================================
// Dashboard BFF session (SPA path)
// ============================================================
//
// The Vite SPA (apps/dashboard-spa) has no server of its own, so apps/api owns
// the WorkOS OAuth handshake and a session cookie. This module is the pure
// mechanism: (1) seal/unseal the WorkOS token pair into an encrypted cookie
// (JWE, so the browser holds an opaque httpOnly blob and the token never enters
// JS), and (2) the raw-HTTP WorkOS user-management calls (authorize URL, code
// exchange, refresh) — mirroring how workos-directory.ts already talks to
// WorkOS over fetch rather than pulling in the SDK.
//
// The Next dashboard's Bearer-JWT path (S14) is untouched; this is an ADDITIVE
// second credential. The api's existing JWKS verifier verifies the sealed
// access token exactly as it verifies a forwarded bearer.

/** The signed-in WorkOS user, as much as the SPA needs for display. */
export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

/** What we seal into the httpOnly cookie. */
export interface SessionPayload {
  /** WorkOS access token (RS256 JWT) — verified by the same JWKS verifier. */
  readonly accessToken: string;
  /** WorkOS refresh token — used server-side to re-mint an expired session. */
  readonly refreshToken: string;
  readonly user: SessionUser;
}

export interface SessionCodec {
  seal(payload: SessionPayload): Promise<string>;
  /** Unseal, or null on absence / tamper / wrong key / malformed. */
  unseal(value: string): Promise<SessionPayload | null>;
}

/** AuthKit's default cookie name is app-specific; we own ours. */
export const SESSION_COOKIE_NAME = "sa-dash-session";

const KEY_ALG = "dir";
const KEY_ENC = "A256GCM";

// A256GCM needs a 32-byte key; SHA-256 of the password gives exactly that
// (same "derive a fixed key from a secret string" shape iron-session uses).
const deriveKey = (password: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(password).digest());

const normalizeUser = (u: SessionUser): SessionUser => ({
  id: u.id,
  email: u.email ?? null,
  firstName: u.firstName ?? null,
  lastName: u.lastName ?? null,
});

const isSessionPayload = (v: unknown): v is SessionPayload => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const u = p["user"];
  return (
    typeof p["accessToken"] === "string" &&
    typeof p["refreshToken"] === "string" &&
    typeof u === "object" &&
    u !== null &&
    typeof (u as Record<string, unknown>)["id"] === "string"
  );
};

export const makeSessionCodec = (password: string): SessionCodec => {
  const key = deriveKey(password);
  return {
    async seal(payload) {
      return new EncryptJWT({ s: { ...payload, user: normalizeUser(payload.user) } })
        .setProtectedHeader({ alg: KEY_ALG, enc: KEY_ENC })
        .setIssuedAt()
        .encrypt(key);
    },
    async unseal(value) {
      if (!value) return null;
      try {
        const { payload } = await jwtDecrypt(value, key, {
          keyManagementAlgorithms: [KEY_ALG],
          contentEncryptionAlgorithms: [KEY_ENC],
        });
        const s = (payload as { s?: unknown }).s;
        if (!isSessionPayload(s)) return null;
        return { ...s, user: normalizeUser(s.user) };
      } catch {
        return null;
      }
    },
  };
};

// ---- Cookie header helpers ----

/** Parse a raw `Cookie:` header into a name → value map (trimmed). */
export const parseCookieHeader = (
  header: string | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
};

// 400-day cookie lifetime like AuthKit — the sealed tokens inside are the
// actual time-limited element (verified on every request, refreshed on lapse).
const DEFAULT_MAX_AGE_SEC = 60 * 60 * 24 * 400;

interface CookieOpts {
  /**
   * true → cross-site prod posture: `Secure; SameSite=None` (the SPA and api
   * are on different sites, so the credentialed cookie must be None+Secure).
   * false → local http dev: `SameSite=Lax`, no Secure (both on localhost, which
   * is same-site, so Lax is sent and a Secure cookie wouldn't survive http).
   */
  readonly secure: boolean;
  readonly maxAgeSec?: number;
}

const cookieAttrs = (secure: boolean): string => {
  const sameSite = secure ? "None" : "Lax";
  return `Path=/; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
};

export const serializeSessionCookie = (
  value: string,
  opts: CookieOpts,
): string =>
  `${SESSION_COOKIE_NAME}=${value}; ${cookieAttrs(opts.secure)}; Max-Age=${
    opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC
  }`;

export const serializeSessionClearCookie = (
  opts: Pick<CookieOpts, "secure">,
): string => `${SESSION_COOKIE_NAME}=; ${cookieAttrs(opts.secure)}; Max-Age=0`;

// ---- CSRF (cookie path only) ----

export const isAllowedOrigin = (
  origin: string | undefined,
  allowed: ReadonlySet<string>,
): boolean => !!origin && allowed.has(origin);

const hasSessionCookie = (cookieHeader: string | undefined): boolean =>
  new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=`, "u").test(cookieHeader ?? "");

/**
 * Whether a `/dashboard/*` request should be rejected as a CSRF risk. The SPA's
 * session cookie is `SameSite=None` in prod (cross-site SPA↔api), so a state-
 * changing request authenticated by that ambient cookie must additionally prove
 * it came from an allowed origin. Skipped for:
 *   - non-`/dashboard/*` routes (webhooks/OAuth aren't browser-cookie-driven),
 *   - safe methods (GET/HEAD/OPTIONS) incl. the OAuth callback + preflight,
 *   - Bearer requests (the Next dashboard is server-to-server; no ambient cookie),
 *   - requests that don't carry our session cookie at all.
 */
export const csrfRejected = (input: {
  readonly url: string;
  readonly method: string;
  readonly cookieHeader: string | undefined;
  readonly authorizationHeader: string | undefined;
  readonly origin: string | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
}): boolean => {
  if (!input.url.startsWith("/dashboard/")) return false;
  const method = input.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if ((input.authorizationHeader ?? "").startsWith("Bearer ")) return false;
  if (!hasSessionCookie(input.cookieHeader)) return false;
  return !isAllowedOrigin(input.origin, input.allowedOrigins);
};

// ---- OAuth `state` (login-CSRF binding + returnTo) ----
//
// The authorize `state` carries a random nonce + the post-login returnTo, HMAC-
// signed with the api's state key (same pattern as install-grant.ts). At login
// we also drop a short-lived `sa-oauth-state` cookie holding the nonce; at
// callback we require the state's nonce to equal the cookie's — binding the
// callback to the browser that started the flow (prevents login CSRF), the way
// AuthKit's built-in state does for the Next app.

export const OAUTH_STATE_COOKIE = "sa-oauth-state";
const OAUTH_STATE_MAX_AGE_SEC = 600;

export interface OAuthState {
  readonly nonce: string;
  readonly returnTo: string;
}

export const signOAuthState = (key: string, data: OAuthState): string => {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
};

export const verifyOAuthState = (
  key: string,
  token: string,
): OAuthState | null => {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (
      d &&
      typeof d.nonce === "string" &&
      typeof d.returnTo === "string"
    ) {
      return { nonce: d.nonce, returnTo: d.returnTo };
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Reduce a caller-supplied returnTo to a safe SAME-ORIGIN relative path (open-
 * redirect guard): must start with a single "/", never "//" or a scheme.
 */
export const sanitizeReturnPath = (p: string | null | undefined): string => {
  if (!p || !p.startsWith("/") || p.startsWith("//")) return "/";
  if (p.includes("\\") || [...p].some((c) => c.charCodeAt(0) <= 0x20)) return "/";
  return p;
};

export const serializeStateCookie = (
  nonce: string,
  opts: Pick<CookieOpts, "secure">,
): string =>
  // SameSite=Lax so it survives the top-level redirect back from WorkOS.
  `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax${
    opts.secure ? "; Secure" : ""
  }; Max-Age=${OAUTH_STATE_MAX_AGE_SEC}`;

export const serializeStateClearCookie = (
  opts: Pick<CookieOpts, "secure">,
): string =>
  `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${
    opts.secure ? "; Secure" : ""
  }; Max-Age=0`;

// ============================================================
// WorkOS User Management OAuth (raw HTTP)
// ============================================================

const WORKOS_BASE = "https://api.workos.com";
type FetchFn = typeof fetch;

/** Build the WorkOS AuthKit authorize URL the browser is sent to for login. */
export const buildAuthorizeUrl = (input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly screenHint?: "sign-up" | "sign-in";
  readonly baseUrl?: string;
}): string => {
  const base = (input.baseUrl ?? WORKOS_BASE).replace(/\/+$/u, "");
  const url = new URL(`${base}/user_management/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("state", input.state);
  if (input.screenHint === "sign-up") {
    url.searchParams.set("screen_hint", "sign-up");
  }
  return url.toString();
};

export type WorkosAuthOutcome =
  | {
      readonly ok: true;
      readonly session: SessionPayload;
      readonly organizationId: string | null;
    }
  | { readonly ok: false; readonly error: string };

const parseAuthenticateResponse = (body: unknown): WorkosAuthOutcome => {
  const b = body as Record<string, unknown> | null;
  const accessToken = b?.["access_token"];
  const refreshToken = b?.["refresh_token"];
  const rawUser = b?.["user"] as Record<string, unknown> | undefined;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    !rawUser ||
    typeof rawUser["id"] !== "string"
  ) {
    return { ok: false, error: "malformed_workos_response" };
  }
  const orgId = b?.["organization_id"];
  return {
    ok: true,
    session: {
      accessToken,
      refreshToken,
      user: {
        id: rawUser["id"],
        email:
          typeof rawUser["email"] === "string" ? rawUser["email"] : null,
        firstName:
          typeof rawUser["first_name"] === "string"
            ? rawUser["first_name"]
            : null,
        lastName:
          typeof rawUser["last_name"] === "string"
            ? rawUser["last_name"]
            : null,
      },
    },
    organizationId: typeof orgId === "string" && orgId.length > 0 ? orgId : null,
  };
};

const authenticate = async (
  grant: Record<string, string>,
  opts: {
    readonly clientId: string;
    readonly apiKey: string;
    readonly fetchImpl?: FetchFn;
    readonly baseUrl?: string;
  },
): Promise<WorkosAuthOutcome> => {
  const base = (opts.baseUrl ?? WORKOS_BASE).replace(/\/+$/u, "");
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${base}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        client_secret: opts.apiKey,
        ...grant,
      }),
    });
    if (!res.ok) return { ok: false, error: `workos_${res.status}` };
    return parseAuthenticateResponse(await res.json());
  } catch {
    return { ok: false, error: "workos_unreachable" };
  }
};

/** Exchange the OAuth authorization code for a WorkOS token pair. */
export const exchangeAuthorizationCode = (input: {
  readonly clientId: string;
  readonly apiKey: string;
  readonly code: string;
  readonly fetchImpl?: FetchFn;
  readonly baseUrl?: string;
}): Promise<WorkosAuthOutcome> =>
  authenticate(
    { grant_type: "authorization_code", code: input.code },
    input,
  );

/** Re-mint an expired session from its refresh token. */
export const refreshAccessToken = (input: {
  readonly clientId: string;
  readonly apiKey: string;
  readonly refreshToken: string;
  readonly organizationId?: string;
  readonly fetchImpl?: FetchFn;
  readonly baseUrl?: string;
}): Promise<WorkosAuthOutcome> =>
  authenticate(
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      ...(input.organizationId
        ? { organization_id: input.organizationId }
        : {}),
    },
    input,
  );
