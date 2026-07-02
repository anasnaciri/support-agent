import type { WorkspacesResponse } from "@support-agent/dashboard-contracts";

import { isOnboardingRequired, type Whoami } from "./auth/session-api";

export type OnboardingDisposition = "loading" | "show_form" | "redirect_home";

/**
 * Public `/onboarding` can be reached from true first-run setup or from a stale
 * client redirect. An authenticated user who already has a workspace should not
 * be asked to create another one just to get back into the app.
 */
export const onboardingDisposition = (
  session: Whoami | null,
  workspaces: WorkspacesResponse | null,
): OnboardingDisposition => {
  if (!session) return "loading";
  if (isOnboardingRequired(session)) return "show_form";
  if (!workspaces) return "loading";
  return workspaces.workspaces.length > 0 ? "redirect_home" : "show_form";
};
