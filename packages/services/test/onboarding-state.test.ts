import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEP_KEYS,
  ONBOARDING_STATE_VERSION,
  advanceOnboardingState,
  decodeOnboardingState,
  freshOnboardingState,
  isOnboardingStepKey,
  onboardingPending,
} from "../src/onboarding-state";

describe("decodeOnboardingState", () => {
  it("returns null for a tenant that has never been stamped", () => {
    // The load-bearing case: every PRE-EXISTING tenant row has no `onboarding`
    // key, and must never be shown the wizard.
    expect(decodeOnboardingState(undefined)).toBeNull();
    expect(decodeOnboardingState(null)).toBeNull();
  });

  it("returns null for a non-object or an array", () => {
    expect(decodeOnboardingState("yes")).toBeNull();
    expect(decodeOnboardingState(42)).toBeNull();
    expect(decodeOnboardingState([])).toBeNull();
  });

  it("decodes a freshly stamped state", () => {
    expect(decodeOnboardingState({ version: 1, steps: {} })).toEqual({
      version: ONBOARDING_STATE_VERSION,
      steps: {},
      currentStep: null,
      completedAt: null,
      dismissedAt: null,
    });
  });

  it("keeps known step statuses and drops unknown steps and statuses", () => {
    const decoded = decodeOnboardingState({
      version: 1,
      steps: {
        store: "done",
        telegram: "skipped",
        // A step key removed in a later version of the wizard.
        legacy_step: "done",
        // A status we never write.
        facts: "in_progress",
      },
    });
    expect(decoded?.steps).toEqual({ store: "done", telegram: "skipped" });
  });

  it("keeps a known currentStep and drops an unknown one", () => {
    expect(decodeOnboardingState({ version: 1, steps: {}, currentStep: "llm" })
      ?.currentStep).toBe("llm");
    expect(
      decodeOnboardingState({ version: 1, steps: {}, currentStep: "nope" })
        ?.currentStep,
    ).toBeNull();
  });

  it("reads the terminal timestamps", () => {
    const decoded = decodeOnboardingState({
      version: 1,
      steps: {},
      completedAt: "2026-07-14T10:00:00.000Z",
      dismissedAt: "2026-07-14T09:00:00.000Z",
    });
    expect(decoded?.completedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(decoded?.dismissedAt).toBe("2026-07-14T09:00:00.000Z");
  });

  it("tolerates a missing steps map", () => {
    expect(decodeOnboardingState({ version: 1 })?.steps).toEqual({});
  });

  it("rejects a state written by a newer wizard version", () => {
    // Forwards-incompatible state must not be half-read: treat as absent so the
    // older binary leaves it alone rather than clobbering it.
    expect(decodeOnboardingState({ version: 2, steps: {} })).toBeNull();
  });
});

describe("onboardingPending", () => {
  it("is false for an unstamped tenant", () => {
    expect(onboardingPending(null)).toBe(false);
  });

  it("is true for a stamped, unfinished tenant", () => {
    expect(onboardingPending(freshOnboardingState())).toBe(true);
  });

  it("is false once completed", () => {
    expect(
      onboardingPending({
        ...freshOnboardingState(),
        completedAt: "2026-07-14T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("is false once dismissed with 'Set up later'", () => {
    expect(
      onboardingPending({
        ...freshOnboardingState(),
        dismissedAt: "2026-07-14T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("advanceOnboardingState", () => {
  it("records a step status and moves the resume pointer", () => {
    const next = advanceOnboardingState(freshOnboardingState(), {
      step: "store",
      status: "done",
      nextStep: "docs",
    });
    expect(next.steps["store"]).toBe("done");
    expect(next.currentStep).toBe("docs");
  });

  it("records a skip", () => {
    const next = advanceOnboardingState(freshOnboardingState(), {
      step: "telegram",
      status: "skipped",
    });
    expect(next.steps["telegram"]).toBe("skipped");
  });

  it("moves the resume pointer alone when no status is given", () => {
    // Used before an OAuth redirect leaves the SPA: remember where to come back
    // to WITHOUT claiming the step is finished.
    const next = advanceOnboardingState(freshOnboardingState(), {
      nextStep: "email",
    });
    expect(next.currentStep).toBe("email");
    expect(next.steps).toEqual({});
  });

  it("preserves earlier steps and the state version", () => {
    const first = advanceOnboardingState(freshOnboardingState(), {
      step: "store",
      status: "done",
    });
    const second = advanceOnboardingState(first, {
      step: "docs",
      status: "skipped",
    });
    expect(second.steps).toEqual({ store: "done", docs: "skipped" });
    expect(second.version).toBe(ONBOARDING_STATE_VERSION);
  });

  it("does not resurrect a completed state", () => {
    const completed = {
      ...freshOnboardingState(),
      completedAt: "2026-07-14T10:00:00.000Z",
    };
    const next = advanceOnboardingState(completed, {
      step: "store",
      status: "done",
    });
    expect(next.completedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(onboardingPending(next)).toBe(false);
  });
});

describe("isOnboardingStepKey", () => {
  it("accepts every declared key and rejects anything else", () => {
    for (const key of ONBOARDING_STEP_KEYS) {
      expect(isOnboardingStepKey(key)).toBe(true);
    }
    expect(isOnboardingStepKey("nope")).toBe(false);
    expect(isOnboardingStepKey("")).toBe(false);
  });

  it("lists the eleven wizard steps in presentation order", () => {
    expect(ONBOARDING_STEP_KEYS).toEqual([
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
    ]);
  });
});
