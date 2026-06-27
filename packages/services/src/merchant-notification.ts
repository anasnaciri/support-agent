import { Context, Data, Effect, Layer } from "effect";
import type { CaseId, TenantId } from "@support-agent/agent-core";

// ============================================================
// MerchantNotificationService
// ============================================================
//
// Push notifications FROM the platform TO the merchant's operator, over
// whatever chat channel the tenant has connected (Telegram first; the
// master-plan §9 "NotificationService fan-out" envisions Slack/SMS later).
//
// Distinct from the two existing outbound surfaces:
//   - `ConversationService` — tenant mailbox → CUSTOMER. Never used here.
//   - `PlatformMailService` — platform domain → operator EMAIL. Durable,
//     formal (approval links, deletion notices). This service is the
//     lightweight real-time ping next to it.
//
// "No channel connected" is NOT an error: callers are best-effort
// emitters (runtime escalations, crons) or the `merchant.notify` tool,
// which wants to tell the agent the merchant didn't get the ping —
// so it surfaces as `{ delivered: false, channel: null }`.

export type MerchantNotificationKind =
  /** Agent-initiated heads-up via the `merchant.notify` tool. */
  | "agent_note"
  /** A tool call parked the case in `waiting_for_approval`. */
  | "approval_requested"
  /** The case was escalated to `human_takeover`. */
  | "human_takeover"
  /** A connector's health flipped ok → broken. */
  | "connector_broken"
  /** The tenant's metered LLM balance dropped under the alert threshold. */
  | "llm_credits_low";

export interface MerchantNotification {
  readonly kind: MerchantNotificationKind;
  /** Short headline, plain text (channel impls render it as the first line). */
  readonly title: string;
  /** Plain-text body. May contain URLs; channel impls must NOT interpret markup. */
  readonly body: string;
  /** Present when the notification is about a specific case. */
  readonly caseId?: CaseId;
}

export type MerchantNotificationChannel = "telegram" | "email";

export interface MerchantNotifyResult {
  readonly delivered: boolean;
  /**
   * A channel the notification reached, or null when none did. With the
   * multi-channel notifier this is the FIRST channel that delivered (Telegram
   * preferred for its real-time feel); `delivered` is the OR across channels.
   */
  readonly channel: MerchantNotificationChannel | null;
}

export class MerchantNotificationSendFailed extends Data.TaggedError(
  "MerchantNotificationSendFailed",
)<{
  readonly tenantId: TenantId;
  readonly cause: unknown;
}> {}

export class MerchantNotificationService extends Context.Tag(
  "MerchantNotificationService",
)<
  MerchantNotificationService,
  {
    /**
     * Push one notification to the tenant's connected channel.
     * No channel connected → succeeds with `delivered: false` (the
     * caller decides whether that matters); a real transport failure
     * fails with `MerchantNotificationSendFailed`.
     */
    readonly notify: (
      tenantId: TenantId,
      notification: MerchantNotification,
    ) => Effect.Effect<MerchantNotifyResult, MerchantNotificationSendFailed>;
  }
>() {}

// ============================================================
// Pure notification builders
// ============================================================
//
// Copy lives here — pure and unit-tested — so the runtime / worker
// emitters and any future channel stay consistent. All plain text
// (channel impls don't interpret markup).

export interface ApprovalRequestedNotificationInput {
  readonly caseId: CaseId;
  readonly toolName: string;
  readonly draftSubject: string | null;
  readonly draftPreview: string;
  readonly approveUrl: string;
  readonly rejectUrl: string;
}

export const approvalRequestedNotification = (
  input: ApprovalRequestedNotificationInput,
): MerchantNotification => ({
  kind: "approval_requested",
  title: input.draftSubject
    ? `Approval needed: ${input.draftSubject}`
    : `Approval needed (${input.toolName})`,
  body: [
    `The agent prepared a "${input.toolName}" action that needs your approval.`,
    ``,
    input.draftPreview,
    ``,
    `Approve: ${input.approveUrl}`,
    `Reject:  ${input.rejectUrl}`,
  ].join("\n"),
  caseId: input.caseId,
});

/**
 * Internal escalation reason codes → copy a merchant can act on. The
 * default branch quotes the code verbatim — better an ugly ping than a
 * silent one when a new reason appears.
 */
const HUMAN_TAKEOVER_REASON_COPY: Readonly<Record<string, string>> = {
  max_turns_exceeded:
    "The agent hit its work limit before it could finish this case.",
  approval_expired:
    "An approval request expired before anyone decided, so the case stopped.",
  approval_input_invalid:
    "An edited approval no longer matched what the action expects, so nothing was sent.",
  approval_denied_by_policy:
    "Your policy settings blocked the approved action from running.",
  approved_tool_failed:
    "The action you approved failed while executing — nothing further was sent.",
  "approval rejected":
    "You rejected the agent's draft, so the case is now with you.",
  llm_credential_missing:
    "Your AI provider key is missing — reconnect it under Settings so the agent can work.",
  llm_credential_revoked:
    "Your AI provider key was revoked — reconnect it under Settings so the agent can work.",
  workflow_retries_exhausted:
    "Processing kept failing and was stopped after several retries.",
};

export interface HumanTakeoverNotificationInput {
  readonly caseId: CaseId;
  readonly subject: string | null;
  readonly reason: string;
}

export const humanTakeoverNotification = (
  input: HumanTakeoverNotificationInput,
): MerchantNotification => {
  const friendly =
    HUMAN_TAKEOVER_REASON_COPY[input.reason] ??
    `The agent stopped and needs a person to continue (${input.reason}).`;
  return {
    kind: "human_takeover",
    title: "A case needs your attention",
    body: [
      ...(input.subject ? [`Case: ${input.subject}`, ``] : []),
      friendly,
      `Open the dashboard to take it from here.`,
    ].join("\n"),
    caseId: input.caseId,
  };
};

export interface LlmCreditsLowNotificationInput {
  /** LLM provider whose balance is low (today always "openrouter"). */
  readonly provider: string;
  /**
   * Remaining prepaid balance in USD. OpenRouter denominates credits in
   * dollars, so this isn't a hardcoded-currency assumption — it's the
   * unit the source API reports.
   */
  readonly remainingUsd: number;
  readonly thresholdUsd: number;
}

export const llmCreditsLowNotification = (
  input: LlmCreditsLowNotificationInput,
): MerchantNotification => ({
  kind: "llm_credits_low",
  title: `Your ${input.provider} credits are running low`,
  body: [
    `Your ${input.provider} balance is down to $${input.remainingUsd.toFixed(2)} (alert threshold $${input.thresholdUsd}).`,
    ``,
    `The agent stops handling customer cases once credits run out — top up your ${input.provider} account to keep it running.`,
  ].join("\n"),
});

export interface ConnectorBrokenNotificationInput {
  readonly provider: string;
  readonly mailbox: string;
  readonly reason: string;
}

export const connectorBrokenNotification = (
  input: ConnectorBrokenNotificationInput,
): MerchantNotification => ({
  kind: "connector_broken",
  title: `Your ${input.provider} connection stopped working`,
  body: [
    `Your ${input.provider} connection (${input.mailbox}) is broken: ${input.reason}.`,
    ``,
    `Inbound customer email is NOT being received until it is reconnected.`,
    `Open Settings → Integrations to reconnect it.`,
  ].join("\n"),
});

// ============================================================
// Test layer
// ============================================================

export interface MerchantNotificationTestRecord {
  readonly tenantId: TenantId;
  readonly notification: MerchantNotification;
  readonly result: MerchantNotifyResult;
}

export interface MerchantNotificationTestHandle {
  /** Every non-failing notify() attempt, including undelivered ones. */
  readonly sent: ReadonlyArray<MerchantNotificationTestRecord>;
}

export interface MerchantNotificationTestFixtures {
  /** When true, every notify fails with MerchantNotificationSendFailed. */
  readonly failAll?: boolean;
  /** Tenants treated as having no connected channel (delivered: false). */
  readonly disconnectedFor?: ReadonlySet<TenantId>;
}

export const makeMerchantNotificationServiceTest = (
  fixtures: MerchantNotificationTestFixtures = {},
): {
  readonly layer: Layer.Layer<MerchantNotificationService>;
  readonly handle: MerchantNotificationTestHandle;
} => {
  const sent: Array<MerchantNotificationTestRecord> = [];
  const layer = Layer.succeed(
    MerchantNotificationService,
    MerchantNotificationService.of({
      notify: (tenantId, notification) =>
        Effect.suspend(
          (): Effect.Effect<
            MerchantNotifyResult,
            MerchantNotificationSendFailed
          > => {
            if (fixtures.failAll) {
              return Effect.fail(
                new MerchantNotificationSendFailed({
                  tenantId,
                  cause: "fixture: failAll",
                }),
              );
            }
            const result: MerchantNotifyResult = fixtures.disconnectedFor?.has(
              tenantId,
            )
              ? { delivered: false, channel: null }
              : { delivered: true, channel: "telegram" };
            sent.push({ tenantId, notification, result });
            return Effect.succeed(result);
          },
        ),
    }),
  );
  const handle: MerchantNotificationTestHandle = {
    get sent() {
      return sent;
    },
  };
  return { layer, handle };
};

/** Layer-only convenience: when the test doesn't need to inspect sends. */
export const MerchantNotificationServiceTest = (
  fixtures: MerchantNotificationTestFixtures = {},
): Layer.Layer<MerchantNotificationService> =>
  makeMerchantNotificationServiceTest(fixtures).layer;
