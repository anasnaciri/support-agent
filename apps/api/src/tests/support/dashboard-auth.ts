import {
  makeStaticDashboardTokenVerifier,
  type DashboardTokenVerifier,
} from "../../auth/dashboard-jwt.js";
import { dashboardUserDecisionUuid } from "../../auth/dashboard-user-id.js";

// Test support for the S14 dashboard auth (forwarded WorkOS JWT).
//
// Production verifies a real RS256 JWT against WorkOS's JWKS. Integration tests
// inject this stand-in verifier instead and present a synthetic bearer of the
// form `dash|<orgId>|<workosUserId>` — letting a test drive exactly which org +
// user a `/dashboard/*` request resolves to, without minting signed tokens.
// Pass it via `startServer(cfg, { dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER })`.

// Org slot may be EMPTY (`dash||user_new`) to model an authenticated user with
// no org yet → the verifier maps that to `missing_claims` (like production),
// distinct from a malformed token (no match → `invalid_token`).
const TOKEN_RE = /^dash\|([^|]*)\|([^|]*)$/u;

export const TEST_DASHBOARD_VERIFIER: DashboardTokenVerifier =
  makeStaticDashboardTokenVerifier((token) => {
    const m = TOKEN_RE.exec(token);
    if (!m) return null;
    return { organizationId: m[1]!, workosUserId: m[2]! || "user_test" };
  });

/** Build the synthetic bearer for an org (+ optional WorkOS user id). */
export const dashboardBearer = (
  orgId: string,
  workosUserId = "user_test",
): string => `dash|${orgId}|${workosUserId}`;

/** `Authorization` + optional extra headers for a `/dashboard/*` request. */
export const dashboardAuthHeaders = (
  orgId: string,
  extra: Record<string, string> = {},
  workosUserId = "user_test",
): Record<string, string> => ({
  authorization: `Bearer ${dashboardBearer(orgId, workosUserId)}`,
  ...extra,
});

/** The decision UUID the api will derive for a given synthetic WorkOS user. */
export const decisionUuidFor = (workosUserId: string): string =>
  dashboardUserDecisionUuid(workosUserId);
