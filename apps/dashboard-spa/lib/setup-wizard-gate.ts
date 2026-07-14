import type {
  OnboardingStateView,
  OnboardingStepKeyView,
  UnifiedWorkspace,
} from "@support-agent/dashboard-contracts";

/** Full-screen wizard route — authed, but outside the dashboard shell. */
export const WELCOME_PATH = "/welcome";

/**
 * Steps in presentation order. Mirrors `ONBOARDING_STEP_KEYS` in
 * packages/services (the server validates against that list); duplicated here
 * because the SPA is a pure api client and doesn't import the services package.
 */
export const WIZARD_STEPS: ReadonlyArray<OnboardingStepKeyView> = [
  "store",
  "docs",
  "facts",
  "policies",
  "scenarios",
  "llm",
  "agent",
  "email",
  "telegram",
  "members",
  "fulfillment_partner",
];

/**
 * Query params the connector callbacks add on their way back to the dashboard
 * (`?connected=shopify&shop=…`, `?error=shopify:access_denied`). A merchant
 * connecting mid-wizard is redirected by the gate below before the integrations
 * page can read them, so they ride along to the wizard, which reports the
 * outcome instead.
 */
const FORWARDED_PARAMS = ["connected", "shop", "error"] as const;

export interface SetupWizardGateInput {
  readonly activeWorkspace: UnifiedWorkspace | null;
  readonly pathname: string;
  /** `window.location.search`, including the leading "?" (or empty). */
  readonly search: string;
}

/**
 * Where a merchant who still owes setup should be sent, or null to stay put.
 *
 * Only MERCHANT workspaces are gated: a fulfillment partner reaches a merchant's
 * workspace through their own walled portal, and the merchant's setup is none of
 * their business. The wizard route itself is never redirected (that would loop,
 * since it renders inside the same session provider).
 */
export const setupWizardRedirect = (
  input: SetupWizardGateInput,
): string | null => {
  const ws = input.activeWorkspace;
  if (!ws) return null; // still bootstrapping
  if (ws.kind !== "merchant") return null;
  if (!ws.onboardingPending) return null;
  if (input.pathname === WELCOME_PATH) return null;

  const incoming = new URLSearchParams(input.search);
  const forward = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = incoming.get(key);
    if (value !== null) forward.set(key, value);
  }
  const query = forward.toString();
  return query ? `${WELCOME_PATH}?${query}` : WELCOME_PATH;
};

/**
 * The step to open the wizard on.
 *
 * Prefers the persisted pointer — that is what survives the OAuth round-trip
 * out of the SPA and the next login. Without one, fall FORWARD to the first
 * step that has neither been done nor skipped, so a merchant is never restarted
 * at a step they already finished. Everything accounted for → the last step,
 * where the finish action lives.
 */
export const resumeStepFor = (
  state: OnboardingStateView,
): OnboardingStepKeyView => {
  if (state.currentStep) return state.currentStep;
  const firstOpen = WIZARD_STEPS.find((step) => !state.steps[step]);
  return firstOpen ?? WIZARD_STEPS[WIZARD_STEPS.length - 1]!;
};
