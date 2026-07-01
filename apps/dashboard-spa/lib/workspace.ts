import type { WorkspaceSummary } from "@support-agent/dashboard-contracts";

/**
 * Which of the org's workspaces the dashboard is pinned to. Set only by the
 * switch/create server actions; read by RSCs on every request. Advisory:
 * the value is validated against the org's live workspace list each request
 * (RSCs can't Set-Cookie, so a stale value can't be healed in place — it's
 * simply ignored until the next switch rewrites it).
 */
export const WORKSPACE_COOKIE = "workspace:id";

export const WORKSPACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Resolve the active workspace: the cookie's, if the org owns it, else the
 * default (the API lists workspaces default-first). Null only when the org
 * has no workspaces at all — the onboarding case.
 */
export const pickActiveWorkspace = (
  workspaces: ReadonlyArray<WorkspaceSummary>,
  cookieValue: string | undefined,
): WorkspaceSummary | null => {
  if (workspaces.length === 0) return null;
  if (cookieValue) {
    const match = workspaces.find((w) => w.id === cookieValue);
    if (match) return match;
  }
  return workspaces[0] ?? null;
};
