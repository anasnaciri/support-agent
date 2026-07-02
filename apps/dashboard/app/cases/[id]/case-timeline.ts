import type {
  CaseConversationThreadUnavailableReason,
} from "@support-agent/dashboard-contracts";

import { caseStatusLabel, humanizeSlug } from "../../../lib/labels";
import {
  shouldShowRetrySendAction,
  type RetrySendVisibilityInput,
} from "./retry-send-visibility";

export type CaseTimelineMode = "full" | "simplified" | "email";

export interface ChatBubbleChromeInput {
  readonly direction: "inbound" | "outbound";
  readonly sanitizedBodyHtml: string | null;
}

/**
 * Does this sanitized email HTML style its own colors? Connectors wrap even
 * plain-text replies in HTML, so "has HTML" says nothing — the signal for the
 * dark-mode paper treatment is an email that hardcodes a palette (inline
 * `color:`/`background`, legacy `bgcolor`/`<font color>`), i.e. one authored
 * against white. Colorless HTML inherits the theme and renders fine on a dark
 * bubble. `border-color` (quoted-reply chrome) is layout, not a palette — the
 * lookbehind keeps `color:` from matching inside it.
 * (Mirror of apps/dashboard-spa/lib/case-timeline.ts.)
 */
const OWN_COLOR_SIGNALS: ReadonlyArray<RegExp> = [
  /(?<![-\w])color\s*:/i,
  /background(?:-color)?\s*:/i,
  /\bbgcolor\s*=/i,
  /<font[^>]*\scolor\s*=/i,
];

export const emailHtmlHasOwnColors = (html: string): boolean =>
  OWN_COLOR_SIGNALS.some((signal) => signal.test(html));

export const chatBubbleChromeClass = (
  message: ChatBubbleChromeInput,
): string => {
  const outbound = message.direction === "outbound";
  return [
    "max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
    outbound
      ? "rounded-br-sm bg-primary text-primary-foreground"
      : [
          "rounded-bl-sm border border-border bg-card text-foreground",
          message.sanitizedBodyHtml &&
          emailHtmlHasOwnColors(message.sanitizedBodyHtml)
            ? "email-paper"
            : null,
        ]
          .filter(Boolean)
          .join(" "),
  ].join(" ");
};

/**
 * The curated ("simplified") view is the DEFAULT: merchants see customer
 * messages, the agent's outward findings/answers, and human touchpoints.
 * The full audit trail stays one click away behind `?timeline=full`.
 */
export const parseCaseTimelineMode = (
  value: string | undefined,
): CaseTimelineMode =>
  value === "full" || value === "email" ? value : "simplified";

export const buildCaseTimelineHref = (
  caseId: string,
  params: Readonly<Record<string, string | undefined>>,
  mode: CaseTimelineMode,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  if (mode === "simplified") {
    query.delete("timeline");
  } else {
    query.set("timeline", mode);
  }
  const search = query.toString();
  return search ? `/cases/${caseId}?${search}` : `/cases/${caseId}`;
};

// ============================================================
// Curated timeline events
// ============================================================
//
// Maps raw audit entries onto the merchant-facing timeline. Deliberately
// allow-listed: anything not matched here (agent handoffs, Shopify /
// knowledge lookups, case bookkeeping, llm.decision rows, runtime holds)
// is internal plumbing and stays hidden. Approvals are NOT mapped from
// audit rows — the page builds richer approval cards from the approval
// records themselves.

export interface CuratedAuditEntry {
  readonly id: string;
  readonly action: string;
  readonly details: unknown;
  readonly occurredAt: string;
  readonly actorType?: string | null;
  readonly actorId?: string | null;
}

export type CuratedTimelineItem =
  | {
      readonly kind: "email";
      readonly id: string;
      readonly title: "Email received" | "Email sent";
      readonly responsible: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "note";
      readonly id: string;
      /** Heads-up title the agent sent the merchant. */
      readonly title: string;
      readonly message: string | null;
      /** Whether the ping reached a connected channel; null on older rows. */
      readonly delivered: boolean | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "status";
      readonly id: string;
      readonly title: string;
      readonly description: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "deliveryFailed";
      readonly id: string;
      readonly title: "Email failed to send";
      /** Last transport error, surfaced so the merchant knows why. */
      readonly lastError: string | null;
      readonly occurredAt: string;
    };

const INBOUND_EMAIL_EVENTS = new Set(["message.received", "customer.replied"]);
const OUTBOUND_EMAIL_TOOLS = new Set([
  "conversation.reply",
  "conversation.ask_customer",
]);

/** Merchant-facing copy for escalation reason codes (mirrors the
 * runtime's Telegram copy); unknown codes are humanized — still shown
 * (better than a hidden escalation), but never as a raw snake_case code. */
const ESCALATION_REASON_COPY: Readonly<Record<string, string>> = {
  max_turns_exceeded: "The agent hit its work limit before finishing.",
  approval_expired: "An approval request expired before anyone decided.",
  approval_input_invalid:
    "An edited approval no longer matched what the action expects.",
  approval_denied_by_policy:
    "Your policy settings blocked the approved action.",
  approved_tool_failed: "The approved action failed while executing.",
  approved_tool_unavailable: "The approved action is no longer available.",
  approval_not_runnable:
    "The approval was no longer runnable when the workflow resumed.",
  supplier_unreachable: "The supplier could not be reached.",
  "approval rejected": "A draft was rejected, so the case moved to you.",
  llm_credential_missing: "The AI provider key is missing.",
  llm_credential_revoked: "The AI provider key was revoked.",
  llm_insufficient_credits:
    "The AI provider account is out of credits — top up to continue.",
  workflow_retries_exhausted:
    "Processing kept failing and was stopped after several retries.",
  llm_context_too_large: "The conversation grew too large for the AI model.",
  llm_safety_blocked: "The AI model declined to continue on this content.",
};

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const curatedTimelineEvent = (
  entry: CuratedAuditEntry,
  customerEmail: string | null,
): CuratedTimelineItem | null => {
  const details = rec(entry.details) ?? {};

  if (entry.action === "event.received") {
    const eventType = str(details["eventType"]);
    if (!eventType || !INBOUND_EMAIL_EVENTS.has(eventType)) return null;
    return {
      kind: "email",
      id: `audit-${entry.id}`,
      title: "Email received",
      responsible: customerEmail ? `Customer: ${customerEmail}` : "Customer",
      occurredAt: entry.occurredAt,
    };
  }

  if (entry.action === "tool.invoked") {
    const tool = str(details["tool"]);
    if (!tool || details["ok"] === false) return null;
    if (OUTBOUND_EMAIL_TOOLS.has(tool)) {
      return {
        kind: "email",
        id: `audit-${entry.id}`,
        title: "Email sent",
        responsible:
          entry.actorType === "agent"
            ? `Agent ${entry.actorId ?? "unknown"}`
            : (entry.actorId ?? "System"),
        occurredAt: entry.occurredAt,
      };
    }
    if (tool === "merchant.notify") {
      const notify = rec(details["notify"]);
      return {
        kind: "note",
        id: `audit-${entry.id}`,
        title: str(notify?.["title"]) ?? "Heads-up sent to you",
        message: str(notify?.["message"]),
        delivered:
          typeof notify?.["delivered"] === "boolean"
            ? notify["delivered"]
            : null,
        occurredAt: entry.occurredAt,
      };
    }
    return null;
  }

  if (entry.action === "case.escalated_to_human") {
    const reason = str(details["reason"]);
    return {
      kind: "status",
      id: `audit-${entry.id}`,
      title: "Needs you — the agent stopped here",
      description: reason
        ? (ESCALATION_REASON_COPY[reason] ?? `${humanizeSlug(reason)}.`)
        : null,
      occurredAt: entry.occurredAt,
    };
  }

  if (entry.action === "case.taken_over") {
    return {
      kind: "status",
      id: `audit-${entry.id}`,
      title: "You took over this case",
      description: null,
      occurredAt: entry.occurredAt,
    };
  }

  if (entry.action === "case.resumed") {
    return {
      kind: "status",
      id: `audit-${entry.id}`,
      title: "Handed back to the agent",
      description:
        str(details["trigger"]) === "dashboard_retry"
          ? "Retrying immediately."
          : null,
      occurredAt: entry.occurredAt,
    };
  }

  if (entry.action === "case.resolved") {
    return {
      kind: "status",
      id: `audit-${entry.id}`,
      title: "Case resolved",
      description: null,
      occurredAt: entry.occurredAt,
    };
  }

  if (entry.action === "case.status_changed") {
    const to = str(details["toStatus"]);
    return {
      kind: "status",
      id: `audit-${entry.id}`,
      title: "Status updated",
      description: to ? `Changed to ${caseStatusLabel(to)}.` : null,
      occurredAt: entry.occurredAt,
    };
  }

  return null;
};

// The failed-send card is NOT derived from an audit row (failed `tool.invoked`
// rows stay hidden, above): it mirrors the live reply-delivery outbox so the
// card and the inline "Retry sending email" button share one condition — the
// same `shouldShowRetrySendAction` that gates the header button. `occurredAt`
// is the delivery's `updatedAt` (its last failed attempt), so the card sorts
// to where the send actually broke.
export interface ReplyDeliveryFailedInput
  extends Omit<RetrySendVisibilityInput, "activeReplyDelivery"> {
  readonly activeReplyDelivery: null | {
    readonly id: string;
    readonly status: string;
    readonly lastError: string | null;
    readonly updatedAt: string;
  };
}

export const replyDeliveryFailedTimelineItem = (
  input: ReplyDeliveryFailedInput,
): CuratedTimelineItem | null => {
  if (!shouldShowRetrySendAction(input)) return null;
  const delivery = input.activeReplyDelivery;
  if (!delivery) return null;
  return {
    kind: "deliveryFailed",
    id: `reply-delivery-${delivery.id}`,
    title: "Email failed to send",
    lastError: delivery.lastError,
    occurredAt: delivery.updatedAt,
  };
};

const formatUnit = (value: number, unit: string): string => {
  const rounded =
    value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${unit}`;
};

export const formatAttachmentSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return formatUnit(sizeBytes / 1024, "KB");
  return formatUnit(sizeBytes / (1024 * 1024), "MB");
};

export const conversationThreadUnavailableView = (
  reason: CaseConversationThreadUnavailableReason,
): {
  readonly title: string;
  readonly description: string;
  readonly showIntegrationsLink: boolean;
} => {
  switch (reason) {
    case "no_thread":
      return {
        title: "No email thread linked",
        description: "This case is not linked to a customer email conversation.",
        showIntegrationsLink: false,
      };
    case "thread_not_found":
      return {
        title: "Email thread not found",
        description: "The connected mailbox no longer contains this conversation.",
        showIntegrationsLink: false,
      };
    case "auth_required":
      return {
        title: "Reconnect the mailbox",
        description:
          "The connected mailbox must be reconnected before its email thread can be loaded.",
        showIntegrationsLink: true,
      };
    case "mailbox_ambiguous":
      return {
        title: "Mailbox cannot be safely identified",
        description:
          "This older case is not bound to a specific mailbox, and more than one matching mailbox is connected.",
        showIntegrationsLink: true,
      };
    case "provider_unavailable":
      return {
        title: "Email provider temporarily unavailable",
        description: "Refresh the page to try loading the live email thread again.",
        showIntegrationsLink: false,
      };
  }
};
