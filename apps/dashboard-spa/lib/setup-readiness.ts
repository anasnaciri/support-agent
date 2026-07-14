import type {
  ConnectorConnectionView,
  OnboardingStateView,
} from "@support-agent/dashboard-contracts";

/**
 * The two things a workspace cannot run without, and what it means when they're
 * missing. Shared by the setup wizard (which warns as soon as the merchant
 * passes the step) and the dashboard shell (which keeps warning afterwards).
 *
 * These are not nags. Each one names a capability the workspace genuinely does
 * not have yet:
 *   - no AI provider  → tickets arrive and are never answered (the runtime
 *     parks every ticket in human_takeover, `llm_credential_missing`).
 *   - no inbox        → no tickets arrive at all.
 */

/** Providers that can be a workspace's customer mailbox. */
const MAILBOX_PROVIDERS = ["gmail", "outlook", "imap"] as const;

export type SetupGapKind = "llm" | "mailbox";

export interface SetupGap {
  readonly kind: SetupGapKind;
  /** `error` blocks the product working at all; `warning` blocks its input. */
  readonly severity: "error" | "warning";
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly href: string;
}

const isActive = (
  connections: ReadonlyArray<ConnectorConnectionView>,
  providers: ReadonlyArray<string>,
): boolean =>
  connections.some(
    (c) => providers.includes(c.provider) && c.status === "active",
  );

export const hasMailbox = (
  connections: ReadonlyArray<ConnectorConnectionView>,
): boolean => isActive(connections, MAILBOX_PROVIDERS);

export interface SetupReadinessInput {
  /**
   * Whether an LLM credential RESOLVES for this workspace — its own key or the
   * account-level fallback. Read from `GET /dashboard/llm` (`effective`), not
   * from the connection list, because that is what the runtime resolves too.
   */
  readonly llmConnected: boolean;
  readonly mailboxConnected: boolean;
  /**
   * Inside the wizard, only warn about a step the merchant has already passed —
   * telling someone they're missing an API key on the step BEFORE they're asked
   * for one is just noise. The dashboard shell passes `null`, where every gap
   * is worth reporting.
   */
  readonly steps: OnboardingStateView["steps"] | null;
}

export const setupGaps = (
  input: SetupReadinessInput,
): ReadonlyArray<SetupGap> => {
  const reached = (step: "llm" | "email") =>
    input.steps === null || Boolean(input.steps[step]);

  const gaps: SetupGap[] = [];
  if (!input.llmConnected && reached("llm")) {
    gaps.push({
      kind: "llm",
      severity: "error",
      title: "Ticket processing is paused",
      detail:
        "Your agent needs an AI provider key to answer anything. Until you connect one, tickets will pile up unanswered.",
      actionLabel: "Connect a provider",
      href: "/settings/llm",
    });
  }
  if (!input.mailboxConnected && reached("email")) {
    gaps.push({
      kind: "mailbox",
      severity: "warning",
      title: "No inbox connected",
      detail:
        "Customer emails reach your agent through a connected inbox. Without one, no tickets will arrive.",
      actionLabel: "Connect an inbox",
      href: "/settings/integrations",
    });
  }
  return gaps;
};
