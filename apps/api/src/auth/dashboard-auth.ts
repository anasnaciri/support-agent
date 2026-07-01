import { timingSafeEqual } from "node:crypto";

import { dashboardUserDecisionUuid } from "./dashboard-user-id.js";
import type {
  DashboardTokenVerifier,
  DashboardTokenVerifyFailure,
} from "./dashboard-jwt.js";
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  type SessionCodec,
} from "./dashboard-session.js";

// Auth for the dashboard's HTTP API (Path B). The dashboard (a Cloudflare
// Worker) authenticates the merchant via WorkOS and forwards that merchant's
// WorkOS access token (an RS256 JWT). The api VERIFIES the JWT against WorkOS's
// client-scoped JWKS (see dashboard-jwt.ts) and reads the org + user from the
// verified claims. Nothing the caller asserts in a header decides identity:
// `x-org-id` / `x-user-id` are gone, so a leaked credential can no longer be
// used to act as an arbitrary org/user (audit S14).
//
// Still header-carried (NOT identity-bearing): `x-workspace-id` (validated
// against the verified org's tenants after this parse) and `x-user-email`
// (low-trust — display + invite reconcile; see the follow-up in todo.md).

export type DashboardAuthParse =
  | {
      readonly ok: true;
      readonly organizationId: string;
      /**
       * Manager id for write actions — the decision UUID DERIVED from the
       * verified `sub` claim (never a caller header). Always present now that
       * every request carries a verified user; typed optional only so the
       * existing `DashboardAuthResult` shape + its guards are untouched.
       */
      readonly userId: string | undefined;
      /**
       * The raw verified WorkOS user id (`sub`), before hashing to `userId`.
       * Used to resolve the user's VERIFIED email from WorkOS for invite
       * reconcile (so that path never trusts the `x-user-email` header).
       */
      readonly workosUserId: string | undefined;
      /**
       * The acting user's email (from `x-user-email`) — used to display members,
       * reconcile pending invitations, and stamp the auto-claimed Owner row.
       * Low-trust: the access token carries no verified email, so this is a
       * forwarded header. It can only ever act within the verified org.
       */
      readonly userEmail: string | undefined;
      /**
       * Workspace (tenant row) the request is pinned to, from `x-workspace-id`.
       * Undefined → the org's default workspace. Shape + ownership are checked
       * after parsing, against the DB and the VERIFIED org.
       */
      readonly workspaceId: string | undefined;
    }
  | { readonly ok: false; readonly status: 401; readonly message: string };

/**
 * `tenants.id` is a Postgres `uuid` — comparing it against a non-UUID string
 * throws a cast error (a 500). Gate the self-asserted `x-workspace-id` on
 * shape so garbage becomes a clean 400 before any query runs.
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isWorkspaceIdShape = (value: string): boolean =>
  UUID_SHAPE.test(value);

const BEARER = "Bearer ";

const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; guard so a wrong-length token
  // is a clean false, not an exception.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

const nonEmpty = (v: string | undefined): string | undefined =>
  v && v.length > 0 ? v : undefined;

const failureMessage = (reason: DashboardTokenVerifyFailure): string => {
  switch (reason) {
    case "missing_token":
      return "missing bearer token";
    case "expired":
      return "expired token";
    case "missing_claims":
      return "token missing org/user claims";
    case "invalid_token":
      return "invalid token";
  }
};

/**
 * Verify the dashboard's `Authorization: Bearer <workos-access-token>` and
 * project it onto the org + user the request acts as. Identity (org, user)
 * comes ONLY from the cryptographically-verified JWT claims; `x-workspace-id`
 * and `x-user-email` are read as plain (non-identity) headers. Header keys are
 * expected lowercased (as Fastify delivers them).
 */
export const authenticateDashboardToken = async (
  headers: Record<string, string | undefined>,
  verifier: DashboardTokenVerifier,
): Promise<DashboardAuthParse> => {
  const auth = headers["authorization"];
  const token =
    auth && auth.startsWith(BEARER) ? auth.slice(BEARER.length) : "";
  const verified = await verifier.verify(token);
  if (!verified.ok) {
    return { ok: false, status: 401, message: failureMessage(verified.reason) };
  }
  return {
    ok: true,
    organizationId: verified.claims.organizationId,
    userId: dashboardUserDecisionUuid(verified.claims.workosUserId),
    workosUserId: verified.claims.workosUserId,
    userEmail: nonEmpty(headers["x-user-email"]),
    workspaceId: nonEmpty(headers["x-workspace-id"]),
  };
};

/**
 * Dual-credential dashboard auth. The Next dashboard forwards a WorkOS bearer
 * (S14); the Vite SPA (apps/dashboard-spa) presents the httpOnly `sa-dash-session`
 * cookie apps/api minted at OAuth callback. BOTH resolve to the same verified
 * org + user:
 *   - Bearer present → delegate to `authenticateDashboardToken` UNCHANGED, so
 *     the Next path is byte-for-byte identical (regression-guarded in tests).
 *   - Else the session cookie → unseal → verify the SEALED access token with the
 *     SAME JWKS verifier. On this path `userEmail` comes from the sealed session
 *     (verified server-side at callback), never the spoofable `x-user-email`
 *     header the SPA can't be trusted to set.
 *
 * `codec` is null when the BFF isn't configured (no `API_SESSION_PASSWORD`) — the
 * cookie path is then unavailable and only the bearer path works.
 */
export const authenticateDashboardCredential = async (
  headers: Record<string, string | undefined>,
  verifier: DashboardTokenVerifier,
  codec: SessionCodec | null,
): Promise<DashboardAuthParse> => {
  const auth = headers["authorization"];
  if (auth && auth.startsWith(BEARER)) {
    return authenticateDashboardToken(headers, verifier);
  }
  if (!codec) {
    return { ok: false, status: 401, message: "missing bearer token" };
  }
  const cookieValue = parseCookieHeader(headers["cookie"])[SESSION_COOKIE_NAME];
  if (!cookieValue) {
    return { ok: false, status: 401, message: "missing session" };
  }
  const sealed = await codec.unseal(cookieValue);
  if (!sealed) {
    return { ok: false, status: 401, message: "invalid session" };
  }
  const verified = await verifier.verify(sealed.accessToken);
  if (!verified.ok) {
    return { ok: false, status: 401, message: failureMessage(verified.reason) };
  }
  return {
    ok: true,
    organizationId: verified.claims.organizationId,
    userId: dashboardUserDecisionUuid(verified.claims.workosUserId),
    workosUserId: verified.claims.workosUserId,
    // Verified email from the sealed session — NOT the x-user-email header.
    userEmail: nonEmpty(sealed.user.email ?? undefined),
    workspaceId: nonEmpty(headers["x-workspace-id"]),
  };
};

export type AdminAuthParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401; readonly message: string };

/**
 * Validate the platform-operator `Authorization: Bearer <admin-token>` for
 * the `/admin/*` routes. No org/tenant scoping — admin acts across tenants.
 * Admin keeps the shared-token model on purpose (a small operator surface,
 * not multi-tenant); the WorkOS-JWT migration (S14) is dashboard-only.
 */
export const parseAdminAuth = (
  headers: Record<string, string | undefined>,
  expectedToken: string,
): AdminAuthParse => {
  const auth = headers["authorization"];
  if (!auth || !auth.startsWith(BEARER)) {
    return { ok: false, status: 401, message: "missing bearer token" };
  }
  const token = auth.slice(BEARER.length);
  if (!constantTimeEqual(token, expectedToken)) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  return { ok: true };
};
