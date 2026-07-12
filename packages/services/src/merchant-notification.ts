import { Context, Data, Effect, Layer } from "effect";
import {
  toolDisplayName,
  type TicketId,
  type TenantId,
} from "@support-agent/agent-core";

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
  /** A tool call parked the ticket in `waiting_for_approval`. */
  | "approval_requested"
  /** The ticket was escalated to `human_takeover`. */
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
  /** Present when the notification is about a specific ticket. */
  readonly ticketId?: TicketId;
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
  readonly ticketId: TicketId;
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
    ``,
    `Reject:  ${input.rejectUrl}`,
  ].join("\n"),
  ticketId: input.ticketId,
});

/**
 * Internal escalation reason codes → copy a merchant can act on. The
 * default branch quotes the code verbatim — better an ugly ping than a
 * silent one when a new reason appears.
 */
const HUMAN_TAKEOVER_REASON_COPY: Readonly<Record<string, string>> = {
  max_turns_exceeded:
    "The agent hit its work limit before it could finish this ticket.",
  approval_expired:
    "An approval request expired before anyone decided, so the ticket stopped.",
  approval_input_invalid:
    "An edited approval no longer matched what the action expects, so nothing was sent.",
  approval_denied_by_policy:
    "Your policy settings blocked the approved action from running.",
  approved_tool_failed:
    "The action you approved failed while executing. Nothing further was sent.",
  "approval rejected":
    "You rejected the agent's draft, so the ticket is now with you.",
  llm_credential_missing:
    "Your AI provider key is missing. Reconnect it under Settings so the agent can work.",
  llm_credential_revoked:
    "Your AI provider key was revoked. Reconnect it under Settings so the agent can work.",
  workflow_retries_exhausted:
    "Processing kept failing and was stopped after several retries.",
};

export interface HumanTakeoverNotificationInput {
  readonly ticketId: TicketId;
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
    title: "A ticket needs your attention",
    body: [
      ...(input.subject ? [`Ticket: ${input.subject}`, ``] : []),
      friendly,
      `Open the dashboard to take it from here.`,
    ].join("\n"),
    ticketId: input.ticketId,
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
    `The agent stops handling customer tickets once credits run out. Top up your ${input.provider} account to keep it running.`,
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

/**
 * One merchant-readable line per queued gated action, assembled from the
 * approval row's structured `proposedInput` — never LLM-generated at send
 * time, so a money amount can't be paraphrased. The line's base is the
 * tool's `TOOL_DISPLAY_NAMES` entry (agent-core — THE naming source of
 * truth), with per-tool detail appended: a verbatim truncated draft quote,
 * a refund amount, a discount value. Unknown tools fall back to the tool
 * id verbatim — better an ugly line than a silent one when a new gated
 * tool appears.
 */
const ACTION_PREVIEW_MAX = 80;

const withoutEmDashes = (text: string): string =>
  text.replace(/\s*—\s*/gu, " - ");

const summaryMoney = (input: Record<string, unknown>): string | null => {
  const m = input["amount"];
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  const amount = typeof r["amount"] === "string" ? r["amount"] : null;
  const currency =
    typeof r["currencyCode"] === "string" ? r["currencyCode"] : null;
  // Never invent a currency — show a bare amount over a wrong "USD".
  if (amount && currency) return `${amount} ${currency}`;
  return amount;
};

export const summarizeApprovalAction = (
  tool: string,
  proposedInput: unknown,
): string => {
  const input = (
    proposedInput && typeof proposedInput === "object" ? proposedInput : {}
  ) as Record<string, unknown>;
  const base = toolDisplayName(tool);
  switch (tool) {
    case "conversation.reply":
    case "conversation.ask_customer": {
      const body =
        typeof input["bodyText"] === "string" ? input["bodyText"] : null;
      if (!body) return base;
      const preview =
        body.length > ACTION_PREVIEW_MAX
          ? `${body.slice(0, ACTION_PREVIEW_MAX)}…`
          : body;
      return `${base}: "${withoutEmDashes(preview)}"`;
    }
    case "refund.create":
    case "order.cancel": {
      const money = summaryMoney(input);
      return money ? `${base}: ${money}` : base;
    }
    case "order.update_shipping_address": {
      // Show WHERE the parcel would be redirected — street + city/province is
      // enough to sanity-check the approval; a phone-only edit has nothing
      // locatable to show.
      const parts = ["address1", "city", "province"]
        .map((k) => (typeof input[k] === "string" ? (input[k] as string) : null))
        .filter((v): v is string => v !== null && v.length > 0);
      return parts.length > 0 ? `${base}: ${parts.join(", ")}` : base;
    }
    case "order.update_tracking": {
      // Show the NUMBER being written — that's what the merchant would
      // sanity-check against the supplier's message.
      const number =
        typeof input["trackingNumber"] === "string"
          ? input["trackingNumber"]
          : null;
      return number ? `${base}: ${number}` : base;
    }
    case "discount.create": {
      const value = typeof input["value"] === "string" ? input["value"] : null;
      if (value && input["valueType"] === "percentage") {
        return `${base}: ${value}%`;
      }
      if (value && input["valueType"] === "fixed_amount") {
        const currency =
          typeof input["currencyCode"] === "string"
            ? input["currencyCode"]
            : null;
        return `${base}: ${value}${currency ? ` ${currency}` : ""}`;
      }
      return base;
    }
    default:
      // `toolDisplayName` echoes unknown ids; quote those so the line
      // still reads as an action rather than a bare identifier.
      return base === tool ? `Run "${tool}"` : base;
  }
};

export interface BundleApprovalRequestedNotificationInput {
  readonly ticketId: TicketId;
  readonly ticketSubject: string | null;
  readonly customerEmail: string | null;
  readonly actions: ReadonlyArray<{
    readonly tool: string;
    readonly proposedInput: unknown;
  }>;
  /** The single review-page link — deliberately the ONLY URL in the ping. */
  readonly reviewUrl: string;
}

/**
 * Merchant ping for a QUEUED BUNDLE park (autonomous loop end). Unlike the
 * single-approval ping there are no bare approve/reject links: a bundle is
 * several actions, so the one link opens a review page that lists them all
 * before any decision.
 */
export const bundleApprovalRequestedNotification = (
  input: BundleApprovalRequestedNotificationInput,
): MerchantNotification => {
  const count = input.actions.length;
  const countLabel = `${count} action${count === 1 ? "" : "s"}`;
  const actionLines = input.actions.map(
    (a, i) => `${i + 1}. ${summarizeApprovalAction(a.tool, a.proposedInput)}`,
  );
  return {
    kind: "approval_requested",
    title: input.ticketSubject
      ? `Approval needed: ${input.ticketSubject}`
      : `Approval needed (${countLabel})`,
    body: [
      `The agent queued ${countLabel} on this ticket and is waiting for your approval.`,
      ``,
      ...(input.customerEmail ? [`Customer: ${input.customerEmail}`, ``] : []),
      ...actionLines,
      ``,
      `Review and approve: ${input.reviewUrl}`,
    ].join("\n"),
    ticketId: input.ticketId,
  };
};
