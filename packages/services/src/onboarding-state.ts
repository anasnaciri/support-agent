/**
 * Per-tenant onboarding (setup wizard) state.
 *
 * Stored as an `onboarding` sub-object of `tenants.settings` (JSONB), written
 * only by the wizard. It is deliberately OUR flag rather than a WorkOS post
 * sign-up trigger: the wizard configures a WORKSPACE (store, facts, policies,
 * LLM key, mailbox), and a workspace is a tenant row here — not an identity
 * concept the auth provider knows about. Keeping it in `tenants.settings` also
 * means the gate survives an auth-provider swap.
 *
 * The load-bearing rule is `decodeOnboardingState(undefined) === null`:
 * **absence of the key means "no onboarding needed"**, so every tenant that
 * existed before the wizard shipped is left alone with no migration. Only rows
 * created from now on are stamped with a fresh state (see `createTenantForOrg`
 * / `createWorkspaceForOrg` in packages/db), and only a stamped row can be
 * pending.
 */

/**
 * The wizard's steps, in presentation order. The order lives here (not in the
 * SPA) so the resume pointer, the API validation, and the UI cannot drift.
 */
export const ONBOARDING_STEP_KEYS = [
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
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

/** A step the merchant finished, or explicitly chose to skip. */
export type OnboardingStepStatus = "done" | "skipped";

/** Bump when the step set changes incompatibly; older binaries then ignore it. */
export const ONBOARDING_STATE_VERSION = 1;

export interface OnboardingState {
  readonly version: number;
  /** Per-step outcome. A step absent from the map has not been reached. */
  readonly steps: Readonly<Partial<Record<OnboardingStepKey, OnboardingStepStatus>>>;
  /**
   * Where to resume. Written before a connector OAuth redirect leaves the SPA
   * (and on every step change), so a round-trip through Shopify/Google lands
   * the merchant back on the step they left rather than at the top.
   */
  readonly currentStep: OnboardingStepKey | null;
  /** Set when the merchant reached the end of the wizard. */
  readonly completedAt: string | null;
  /** Set when the merchant chose "Set up later". */
  readonly dismissedAt: string | null;
}

const STEP_KEY_SET: ReadonlySet<string> = new Set(ONBOARDING_STEP_KEYS);

export const isOnboardingStepKey = (raw: unknown): raw is OnboardingStepKey =>
  typeof raw === "string" && STEP_KEY_SET.has(raw);

const isStatus = (raw: unknown): raw is OnboardingStepStatus =>
  raw === "done" || raw === "skipped";

const timestamp = (raw: unknown): string | null =>
  typeof raw === "string" && raw.length > 0 ? raw : null;

/** The state stamped onto a tenant row at creation: pending, nothing done. */
export const freshOnboardingState = (): OnboardingState => ({
  version: ONBOARDING_STATE_VERSION,
  steps: {},
  currentStep: null,
  completedAt: null,
  dismissedAt: null,
});

/**
 * Decode the `onboarding` block of `tenants.settings`.
 *
 * `null` for an absent block (a pre-wizard tenant — never gated) and for a
 * block written by a NEWER wizard version, which this binary must not
 * half-read and then clobber on the next write. Unknown step keys and statuses
 * are dropped individually so removing a step in a later version can't poison
 * an in-flight state.
 */
export const decodeOnboardingState = (raw: unknown): OnboardingState | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const version = r["version"];
  if (typeof version !== "number" || version > ONBOARDING_STATE_VERSION) {
    return null;
  }

  const steps: Partial<Record<OnboardingStepKey, OnboardingStepStatus>> = {};
  const rawSteps = r["steps"];
  if (typeof rawSteps === "object" && rawSteps !== null && !Array.isArray(rawSteps)) {
    for (const [key, value] of Object.entries(rawSteps)) {
      if (isOnboardingStepKey(key) && isStatus(value)) {
        steps[key] = value;
      }
    }
  }

  const currentStep = r["currentStep"];
  return {
    version: ONBOARDING_STATE_VERSION,
    steps,
    currentStep: isOnboardingStepKey(currentStep) ? currentStep : null,
    completedAt: timestamp(r["completedAt"]),
    dismissedAt: timestamp(r["dismissedAt"]),
  };
};

/**
 * A stamped tenant that has neither finished nor dismissed the wizard. The SPA
 * gate reads exactly this: `true` routes into `/welcome`.
 */
export const onboardingPending = (state: OnboardingState | null): boolean =>
  state !== null && state.completedAt === null && state.dismissedAt === null;

export interface OnboardingAdvance {
  /** The step being recorded. Omit to move the resume pointer alone. */
  readonly step?: OnboardingStepKey;
  readonly status?: OnboardingStepStatus;
  /** Where the merchant is headed — the resume target. */
  readonly nextStep?: OnboardingStepKey;
}

/**
 * Fold one wizard transition into the state. Pure; the caller persists the
 * result. A `step` without a `status` (and vice versa) records nothing but can
 * still move `currentStep` — that is the pre-OAuth-redirect bookmark.
 *
 * Terminal fields are carried through untouched: an `advance` racing a
 * `complete`/`dismiss` must not resurrect a finished wizard.
 */
export const advanceOnboardingState = (
  state: OnboardingState,
  advance: OnboardingAdvance,
): OnboardingState => {
  const steps =
    advance.step && advance.status
      ? { ...state.steps, [advance.step]: advance.status }
      : state.steps;
  return {
    ...state,
    version: ONBOARDING_STATE_VERSION,
    steps,
    currentStep: advance.nextStep ?? state.currentStep,
  };
};
