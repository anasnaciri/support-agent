import { createRemoteJWKSet, jwtVerify } from "jose";

// S14 — forwarded-WorkOS-JWT auth for the dashboard → api edge.
//
// Before S14 the api trusted a shared `DASHBOARD_API_TOKEN` plus a self-asserted
// `x-org-id` header: a leaked service token meant full cross-tenant compromise.
// Now the dashboard forwards the merchant's WorkOS access token (an RS256 JWT),
// and the api VERIFIES it against WorkOS's client-scoped JWKS, reading the org
// and user from the cryptographically-verified claims. A caller can no longer
// assert which org/user they are.

/** Identity extracted from a verified WorkOS access token. */
export interface VerifiedDashboardClaims {
  /** The active WorkOS organization (`org_id` claim). */
  readonly organizationId: string;
  /** The WorkOS user id (`sub` claim) — hashed to the decision UUID by callers. */
  readonly workosUserId: string;
}

export type DashboardTokenVerifyFailure =
  /** No bearer token presented. */
  | "missing_token"
  /** Bad signature, wrong issuer/alg, malformed, or otherwise unverifiable. */
  | "invalid_token"
  /** Signature verified but the token is past its `exp`. */
  | "expired"
  /** Verified, but `org_id` or `sub` is absent — not a usable session token. */
  | "missing_claims";

export type DashboardTokenVerifyResult =
  | { readonly ok: true; readonly claims: VerifiedDashboardClaims }
  | { readonly ok: false; readonly reason: DashboardTokenVerifyFailure };

export interface DashboardTokenVerifier {
  verify(token: string): Promise<DashboardTokenVerifyResult>;
}

/**
 * Exactly what jose's `jwtVerify` accepts as its key argument: a static key
 * (CryptoKey / KeyObject / Uint8Array) or a (remote/local) JWKS resolver. Derived
 * from the function so it tracks jose without importing its key type names
 * (which v5 no longer re-exports).
 */
type KeyInput = Parameters<typeof jwtVerify>[1];

/**
 * Core verifier over any jose key/JWKS resolver. Verifies RS256 signature +
 * `exp` (+ `iss` when configured), then requires `org_id` and `sub`. Pure of
 * any WorkOS specifics so the live (remote JWKS) and test (local JWKS) paths
 * share identical claim-extraction + failure-mapping.
 */
export const makeJwksVerifier = (
  key: KeyInput,
  opts: { readonly issuer?: string; readonly clockToleranceSec?: number } = {},
): DashboardTokenVerifier => ({
  async verify(token) {
    if (!token) return { ok: false, reason: "missing_token" };
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        clockTolerance: opts.clockToleranceSec ?? 0,
        ...(opts.issuer ? { issuer: opts.issuer } : {}),
      });
      const organizationId =
        typeof payload.org_id === "string" && payload.org_id.length > 0
          ? payload.org_id
          : undefined;
      const workosUserId =
        typeof payload.sub === "string" && payload.sub.length > 0
          ? payload.sub
          : undefined;
      if (!organizationId || !workosUserId) {
        return { ok: false, reason: "missing_claims" };
      }
      return { ok: true, claims: { organizationId, workosUserId } };
    } catch (err) {
      // jose tags expiry distinctly; everything else (bad sig, wrong issuer,
      // malformed, unknown kid) collapses to invalid_token.
      const code = (err as { code?: unknown }).code;
      if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
      return { ok: false, reason: "invalid_token" };
    }
  },
});

/** WorkOS publishes a client-scoped JWKS — verifying against it binds the token to our app. */
export const workosJwksUrl = (clientId: string): string =>
  `https://api.workos.com/sso/jwks/${clientId}`;

/**
 * Production verifier: fetch + cache WorkOS's JWKS (jose handles the cache and
 * kid rotation). `createRemoteJWKSet` is lazy — no network until the first
 * verify — so building this at boot is cheap.
 */
export const makeRemoteWorkosVerifier = (
  jwksUrl: string,
  opts: { readonly issuer?: string } = {},
): DashboardTokenVerifier =>
  makeJwksVerifier(createRemoteJWKSet(new URL(jwksUrl)), opts);

/**
 * Test / injection verifier: map a fake token string to claims (or null to
 * reject). Lets integration tests drive the exact org/user a request resolves
 * to without minting real RS256 JWTs.
 */
export const makeStaticDashboardTokenVerifier = (
  resolve: (token: string) => VerifiedDashboardClaims | null,
): DashboardTokenVerifier => ({
  async verify(token) {
    if (!token) return { ok: false, reason: "missing_token" };
    const claims = resolve(token);
    if (!claims) return { ok: false, reason: "invalid_token" };
    // Mirror the JWKS verifier: a token that resolves but lacks an org/user
    // claim is `missing_claims` (e.g. a brand-new org-less user), not invalid.
    if (!claims.organizationId || !claims.workosUserId) {
      return { ok: false, reason: "missing_claims" };
    }
    return { ok: true, claims };
  },
});
