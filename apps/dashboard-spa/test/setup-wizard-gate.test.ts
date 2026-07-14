import { describe, expect, it } from "vitest";
import type { UnifiedWorkspace } from "@support-agent/dashboard-contracts";

import {
  WELCOME_PATH,
  resumeStepFor,
  setupWizardRedirect,
} from "../lib/setup-wizard-gate";

const workspace = (
  over: Partial<UnifiedWorkspace> = {},
): UnifiedWorkspace => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "merchant",
  name: "Acme",
  createdAt: "2026-01-01T00:00:00.000Z",
  shopifyDomain: null,
  onboardingPending: false,
  ...over,
});

describe("setupWizardRedirect", () => {
  it("routes a pending workspace into the wizard", () => {
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: true }),
        pathname: "/",
        search: "",
      }),
    ).toBe(WELCOME_PATH);
  });

  it("leaves a workspace that finished (or never owed) onboarding alone", () => {
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: false }),
        pathname: "/",
        search: "",
      }),
    ).toBeNull();
  });

  it("does not bounce a wizard that is already open", () => {
    // Guards the redirect loop: /welcome renders inside the session provider
    // too, so a gate that fired there would never settle.
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: true }),
        pathname: WELCOME_PATH,
        search: "",
      }),
    ).toBeNull();
  });

  it("never gates a fulfillment partner into the merchant's wizard", () => {
    // A partner reaches a merchant's workspace only through their walled
    // portal. The merchant's setup is none of their business.
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({
          kind: "fulfillment_operator",
          onboardingPending: true,
        }),
        pathname: "/fulfillment-operator/tickets",
        search: "",
      }),
    ).toBeNull();
  });

  it("forwards the connector callback params into the wizard", () => {
    // Shopify/Google send the merchant back to /settings/integrations. Mid
    // onboarding the gate bounces them to the wizard, and the outcome of the
    // connect has to survive that hop or the wizard can't toast it.
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: true }),
        pathname: "/settings/integrations",
        search: "?connected=shopify&shop=acme.myshopify.com",
      }),
    ).toBe(`${WELCOME_PATH}?connected=shopify&shop=acme.myshopify.com`);
  });

  it("forwards a connector error too", () => {
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: true }),
        pathname: "/settings/integrations",
        search: "?error=shopify%3Aaccess_denied",
      }),
    ).toBe(`${WELCOME_PATH}?error=shopify%3Aaccess_denied`);
  });

  it("drops unrelated query params when forwarding", () => {
    expect(
      setupWizardRedirect({
        activeWorkspace: workspace({ onboardingPending: true }),
        pathname: "/tickets",
        search: "?page=3&q=refund",
      }),
    ).toBe(WELCOME_PATH);
  });

  it("waits for a workspace before deciding", () => {
    expect(
      setupWizardRedirect({
        activeWorkspace: null,
        pathname: "/",
        search: "",
      }),
    ).toBeNull();
  });
});

describe("resumeStepFor", () => {
  it("resumes at the persisted pointer", () => {
    expect(
      resumeStepFor({
        pending: true,
        steps: { store: "done" },
        currentStep: "facts",
        completedAt: null,
        dismissedAt: null,
      }),
    ).toBe("facts");
  });

  it("starts at the first step when nothing is recorded", () => {
    expect(
      resumeStepFor({
        pending: true,
        steps: {},
        currentStep: null,
        completedAt: null,
        dismissedAt: null,
      }),
    ).toBe("store");
  });

  it("falls forward to the first unfinished step when the pointer is missing", () => {
    // An older state (or a pointer write that lost a race) must not restart a
    // merchant at a step they already finished.
    expect(
      resumeStepFor({
        pending: true,
        steps: { store: "done", docs: "skipped" },
        currentStep: null,
        completedAt: null,
        dismissedAt: null,
      }),
    ).toBe("facts");
  });

  it("lands on the last step when every step is accounted for", () => {
    expect(
      resumeStepFor({
        pending: true,
        steps: {
          store: "done",
          docs: "done",
          facts: "done",
          policies: "done",
          scenarios: "skipped",
          llm: "done",
          agent: "done",
          email: "done",
          telegram: "skipped",
          members: "skipped",
          fulfillment_partner: "skipped",
        },
        currentStep: null,
        completedAt: null,
        dismissedAt: null,
      }),
    ).toBe("fulfillment_partner");
  });
});
