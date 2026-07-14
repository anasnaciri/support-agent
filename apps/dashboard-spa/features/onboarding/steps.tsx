import type { ComponentType } from "react";
import type {
  OnboardingStepKeyView,
  RbacPermissionId,
} from "@support-agent/dashboard-contracts";

import { WIZARD_STEPS } from "@/lib/setup-wizard-gate";
import { StoreStep } from "./steps/StoreStep";
import { DocsStep } from "./steps/DocsStep";
import { FactsStep } from "./steps/FactsStep";
import { PoliciesStep } from "./steps/PoliciesStep";
import { ScenariosStep } from "./steps/ScenariosStep";
import { LlmStep } from "./steps/LlmStep";
import { AgentStep } from "./steps/AgentStep";
import { EmailStep } from "./steps/EmailStep";
import { TelegramStep } from "./steps/TelegramStep";
import { MembersStep } from "./steps/MembersStep";
import { PartnerStep } from "./steps/PartnerStep";

/**
 * The setup wizard's step registry.
 *
 * Order comes from `WIZARD_STEPS`, which the gate and the API share, so a step
 * can't be listed here in an order the server doesn't recognise. Each step owns
 * its own saving (through the same permission-gated endpoints the settings
 * pages use) and tells the shell when its work has landed.
 */
export interface WizardStepProps {
  /** The step's work is done — record it and move on. */
  readonly onDone: () => void;
  /** False when the member lacks the permission this step's saves need. */
  readonly canEdit: boolean;
}

export interface WizardStepDef {
  readonly key: OnboardingStepKeyView;
  /** Stepper label. */
  readonly title: string;
  /** One line under the heading: what this step is for, in merchant language. */
  readonly blurb: string;
  /** Skippable steps offer "Skip for now"; the rest must be finished or the wizard left. */
  readonly skippable: boolean;
  /** Permission the step's saves require, for the read-only notice. */
  readonly permission: RbacPermissionId;
  readonly Component: ComponentType<WizardStepProps>;
}

const DEFS: Record<OnboardingStepKeyView, Omit<WizardStepDef, "key">> = {
  store: {
    title: "Connect your store",
    blurb:
      "We read your orders, policies, and store pages so the agent can answer with real facts.",
    skippable: false,
    permission: "settings.integrations",
    Component: StoreStep,
  },
  docs: {
    title: "Review your documents",
    blurb:
      "These are the pages we imported. The agent quotes them when a customer asks about your policies.",
    skippable: true,
    permission: "knowledge.manage",
    Component: DocsStep,
  },
  facts: {
    title: "Shipping and returns",
    blurb:
      "The numbers your replies depend on: delivery windows, return window, who pays return shipping.",
    skippable: true,
    permission: "knowledge.manage",
    Component: FactsStep,
  },
  policies: {
    title: "Refunds and discounts",
    blurb:
      "How much the agent may refund or discount on its own, and when it has to ask you first.",
    skippable: true,
    permission: "settings.refund_policy",
    Component: PoliciesStep,
  },
  scenarios: {
    title: "Review your playbooks",
    blurb:
      "How the agent handles each kind of request. Sensible defaults are already in place.",
    skippable: true,
    permission: "settings.agents",
    Component: ScenariosStep,
  },
  llm: {
    title: "Connect an AI provider",
    blurb:
      "Your own API key runs the agent. Without one, tickets arrive but nothing is answered.",
    skippable: true,
    permission: "settings.llm",
    Component: LlmStep,
  },
  agent: {
    title: "Set up your agent",
    blurb:
      "Pick the model, and choose which actions the agent may take on its own.",
    skippable: true,
    permission: "settings.agents",
    Component: AgentStep,
  },
  email: {
    title: "Connect your inbox",
    blurb:
      "Where your customers write to you. The agent reads this inbox and replies from it.",
    skippable: true,
    permission: "settings.integrations",
    Component: EmailStep,
  },
  telegram: {
    title: "Get notified on Telegram",
    blurb:
      "Approvals and anything the agent hands back to you, pushed to your phone.",
    skippable: true,
    permission: "settings.notifications",
    Component: TelegramStep,
  },
  members: {
    title: "Invite your team",
    blurb: "Bring in the people who handle support with you.",
    skippable: true,
    permission: "members.manage",
    Component: MembersStep,
  },
  fulfillment_partner: {
    title: "Add a fulfillment partner",
    blurb:
      "Whoever ships your orders. The agent can ask them about a shipment and wait for the answer.",
    skippable: true,
    permission: "members.manage",
    Component: PartnerStep,
  },
};

export const WIZARD_STEP_DEFS: ReadonlyArray<WizardStepDef> = WIZARD_STEPS.map(
  (key) => ({ key, ...DEFS[key] }),
);

export const stepDefFor = (key: OnboardingStepKeyView): WizardStepDef =>
  WIZARD_STEP_DEFS[WIZARD_STEPS.indexOf(key)]!;

/** Position of a step in the canonical order — the stepper's numbering. */
export const stepIndex = (key: OnboardingStepKeyView): number =>
  WIZARD_STEPS.indexOf(key);
