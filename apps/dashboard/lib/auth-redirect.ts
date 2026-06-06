// Pure routing decisions for the dashboard auth gate. No server-only imports
// (no `withAuth`/`redirect`), so this is unit-testable; lib/api-client.ts
// consumes the constants + resolver. Keeping the policy here means the
// "logged-out users go to the legal-gated /sign-up, not WorkOS-hosted
// /sign-in" rule (audit B2 / re-audit #4) has a regression test.

/** The self-hosted, legal-gated sign-up page (the logged-out front door). */
export const SIGN_UP_PATH = "/sign-up";
/** Onboarding provisions the org + tenant for a signed-in user without one. */
export const ONBOARDING_PATH = "/onboarding";

export interface DashboardAuthState {
  /** A WorkOS session exists. */
  readonly hasUser: boolean;
  /** The session is bound to an organization. */
  readonly hasOrganization: boolean;
  /** The organization maps to a provisioned tenant. */
  readonly hasTenant: boolean;
}

/**
 * Where a request to a tenant-scoped page should be redirected, or `null` to
 * proceed. A logged-out request goes to {@link SIGN_UP_PATH} — never to the
 * WorkOS-hosted sign-in — so the data-processing checkbox can't be skipped.
 * A signed-in user without an org/tenant goes to onboarding.
 */
export const resolveDashboardRedirect = (
  state: DashboardAuthState,
): string | null => {
  if (!state.hasUser) return SIGN_UP_PATH;
  if (!state.hasOrganization) return ONBOARDING_PATH;
  if (!state.hasTenant) return ONBOARDING_PATH;
  return null;
};
