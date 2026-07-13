import { notFound } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { Bot, Check, Hand, RefreshCw } from "lucide-react";
import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import {
  allowedManualStatusTargets,
  type TicketStatus,
  type ShopifyCustomer,
} from "@support-agent/agent-core";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  auditActionLabel,
  ticketStatusLabel,
  humanizeSlug,
  toolActionLabel,
} from "@/lib/labels";
import { ticketStatusVariant } from "@/lib/status-variants";
import { extraWaitChips } from "@/lib/waiting-chips";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Alert, AlertDescription } from "@/components/ui/alert";

import TicketLiveBoundary from "./TicketLiveBoundary";
import { CustomerPanel } from "./CustomerPanel";
import { OrderPanel } from "./OrderPanel";
import { TrackingPanel } from "./TrackingPanel";
import { ApprovalCard } from "./ApprovalCard";
import { BundleApprovalBar } from "./BundleApprovalBar";
import { ChatThread } from "./ChatThread";
import { ChatComposer, type ComposerMode } from "./ChatComposer";
import { ChatScrollArea } from "./ChatScrollArea";
import { TicketDetailsPanel } from "./TicketDetailsPanel";
import { TicketActionsMenu, type TicketMenuAction } from "./TicketActionsMenu";
import { RefundDialog } from "./RefundDialog";
import { ticketActionMenuItems, type TicketActionKey } from "./ticket-actions-menu";
import {
  editTicketDetailsAction,
  issueRefundAction,
  loadRefundContextAction,
  resolveAction,
  resumeAction,
  retryAction,
  retryFromTriageAction,
  retrySendAction,
  setStatusAction,
  takeOverAction,
} from "./actions";
import { CardEditPopover } from "./CardEditPopover";
import {
  buildTicketTimelineHref,
  curatedTimelineEvent,
  replyDeliveryFailedTimelineItem,
  type CuratedTimelineItem,
} from "./ticket-timeline";
import {
  RECOMMENDATION_LABEL,
  extractRefundRecommendation,
  issuableRefund,
  recommendationVariant,
  refundRecommendationFromEntry,
  type RefundRecommendationSummary,
} from "./refund-recommendation";
import {
  parseReturnReason,
  parseRequestedResolution,
  returnReasonLabel,
  requestedResolutionLabel,
  type ReturnReason,
  type RequestedResolution,
} from "./return-labels";
import { riskFlagLabel } from "./risk-flag-label";
import { buildContextRows } from "./ticket-context";
import { parseLiveTracking } from "./tracking-panel-data";
import { shouldShowRetrySendAction } from "./retry-send-visibility";
import { cn } from "@/lib/utils";
import { approvalDisplayNote } from "@/lib/approval-note";

interface Params {
  readonly params: Promise<{
    readonly id: string;
  }>;
  readonly searchParams: Promise<{
    readonly takenOver?: string;
    readonly resumed?: string;
    readonly retried?: string;
    readonly retrySend?: string;
    readonly replied?: string;
    readonly statusChanged?: string;
    readonly ticketResolved?: string;
    readonly refundIssued?: string;
    readonly detailsEdited?: string;
    readonly orderResolved?: string;
    readonly decided?: string;
    readonly action?: string;
    readonly kind?: string;
    readonly timeline?: string;
  }>;
}

type Banner = {
  readonly tone: "success" | "info" | "warn";
  readonly text: string;
};

const takeOverBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "taken_over") {
    return {
      tone: "success",
      text: "You've taken over this ticket. The agent will not act on it further; pending approvals were canceled.",
    };
  }
  if (kind === "already_terminal") {
    return {
      tone: "info",
      text: "This ticket was already in a terminal state — no change.",
    };
  }
  return null;
};

const resumeBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "resumed") {
    return {
      tone: "success",
      text: "Handed back to the agent. It will resume on the customer's next reply.",
    };
  }
  if (kind === "not_in_takeover") {
    return {
      tone: "info",
      text: "This ticket wasn't under human takeover — no change.",
    };
  }
  return null;
};

const retryBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "retried") {
    return {
      tone: "success",
      text: "Handed back to the agent — it's retrying now. New activity will appear in the timeline shortly.",
    };
  }
  if (kind === "resumed_no_tick") {
    return {
      tone: "warn",
      text: "Handed back to the agent, but the retry couldn't be queued. It will resume on the customer's next reply.",
    };
  }
  if (kind === "not_in_takeover") {
    return {
      tone: "info",
      text: "This ticket wasn't under human takeover — no change.",
    };
  }
  return null;
};

const retrySendBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "queued") {
    return {
      tone: "success",
      text: "Re-sending the reply now. If it goes through, the ticket resolves automatically; if it fails again it stays here.",
    };
  }
  if (kind === "no_failed_delivery") {
    return {
      tone: "info",
      text: "There's no failed reply to re-send on this ticket — no change.",
    };
  }
  return null;
};

const replyBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "sent") {
    return { tone: "success", text: "Your reply was sent to the customer." };
  }
  if (kind === "send_failed") {
    return {
      tone: "warn",
      text: "The reply couldn't be sent. Check the connected mailbox and try again.",
    };
  }
  if (kind === "empty_body") {
    return { tone: "warn", text: "Write a message before sending." };
  }
  if (kind === "not_in_takeover") {
    return {
      tone: "info",
      text: "You can only send a manual reply while you've taken over the ticket.",
    };
  }
  if (kind === "no_thread") {
    return {
      tone: "warn",
      text: "This ticket has no connected email thread to reply on.",
    };
  }
  return null;
};

const statusChangedBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "updated") {
    return {
      tone: "success",
      text: "Ticket status updated. Any pending approvals on the ticket were canceled.",
    };
  }
  if (kind === "unchanged") {
    return { tone: "info", text: "That's already the ticket's status — no change." };
  }
  if (kind === "invalid_status") {
    return { tone: "warn", text: "That status can't be set by hand." };
  }
  if (kind === "transition_not_allowed") {
    return {
      tone: "warn",
      text: "That status change isn't allowed from where this ticket is now.",
    };
  }
  return null;
};

const ticketResolvedBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "resolved") {
    return { tone: "success", text: "Ticket resolved." };
  }
  if (kind === "ticket_not_found") {
    return { tone: "warn", text: "Couldn't find that ticket to resolve." };
  }
  return null;
};

const refundIssuedBanner = (kind: string | undefined): Banner | null => {
  if (!kind) return null;
  if (kind === "issued") {
    return {
      tone: "success",
      text: "Refund issued. The customer is notified by Shopify and the refund is recorded on the ticket.",
    };
  }
  if (kind === "already_refunded") {
    return {
      tone: "info",
      text: "That order is already fully refunded — nothing more to issue.",
    };
  }
  if (kind === "order_not_found") {
    return {
      tone: "warn",
      text: "Couldn't find the order to refund. Open it in Shopify to issue the refund there.",
    };
  }
  if (kind === "currency_mismatch") {
    return {
      tone: "warn",
      text: "The refund currency doesn't match the order's — issue this refund in Shopify instead.",
    };
  }
  if (kind === "refund_failed") {
    return {
      tone: "warn",
      text: "Shopify rejected the refund. No money moved — try again or issue it in Shopify.",
    };
  }
  if (kind === "invalid_amount") {
    return { tone: "warn", text: "That refund amount isn't valid." };
  }
  return null;
};

const detailsEditedBanner = (
  kind: string | undefined,
  orderResolved: string | undefined,
): Banner | null => {
  if (!kind) return null;
  if (kind === "saved") {
    if (orderResolved === "true") {
      return { tone: "success", text: "Order linked and ticket details updated." };
    }
    if (orderResolved === "false") {
      return {
        tone: "warn",
        text: "Saved — but we couldn't find that order in your store. It's recorded on the ticket as a reference.",
      };
    }
    return { tone: "success", text: "Ticket details updated." };
  }
  if (kind === "invalid_email") {
    return { tone: "warn", text: "That doesn't look like a valid email address." };
  }
  if (kind === "nothing_to_update") {
    return { tone: "info", text: "Nothing to update." };
  }
  if (kind === "ticket_not_found") {
    return { tone: "warn", text: "Couldn't find that ticket." };
  }
  return null;
};

const approvalBanner = (sp: {
  decided?: string;
  action?: string;
  kind?: string;
}): Banner | null => {
  if (!sp.decided) return null;
  const isApprove = sp.action === "approve";
  if (sp.kind === "decided") {
    return {
      tone: "success",
      text: isApprove
        ? "Approved. The customer reply will be sent in a moment."
        : "Rejected. The ticket is now in human takeover.",
    };
  }
  if (sp.kind === "already_decided") {
    return {
      tone: "info",
      text: "This approval had already been decided — no change.",
    };
  }
  if (sp.kind === "approval_not_found") {
    return { tone: "warn", text: "Approval not found." };
  }
  return null;
};

// Maps each overflow-menu action key (decided by `ticketActionMenuItems`) to the
// server action it submits. Keyed by `TicketActionKey` so a new menu item won't
// type-check until it's wired to an action here.
const TICKET_MENU_ACTIONS: Record<
  TicketActionKey,
  (formData: FormData) => Promise<void>
> = {
  retryNow: retryAction,
  retryFromTriage: retryFromTriageAction,
};

const TERMINAL = new Set(["resolved", "archived", "human_takeover", "failed"]);
// Manual close ("Resolve" button) is offered while the ticket is genuinely live
// and not parked on machinery that owns its own exit (an approval row, a
// supplier escalation, an in-flight approved action). human_takeover IS
// included — a manager who owns the ticket can close it themselves.
const RESOLVE_HIDDEN = new Set([
  "resolved",
  "archived",
  "failed",
  "waiting_for_approval",
  "waiting_for_supplier",
  "approved_action_running",
]);
// Friendlier labels for the status changes folded into the ⋮ menu.
const STATUS_MENU_LABEL: Partial<
  Record<TicketStatus, { readonly label: string; readonly title: string }>
> = {
  in_progress: {
    label: "Reopen (in progress)",
    title: "Move this ticket back to in progress",
  },
  waiting_for_customer: {
    label: "Mark waiting on customer",
    title: "Park this ticket waiting on the customer",
  },
  archived: {
    label: "Archive now",
    title:
      "Archive this ticket without waiting 30 days; it is deleted 12 months after archiving",
  },
  failed: { label: "Mark as failed", title: "Close this ticket as failed" },
};

const toneToVariant = (tone: Banner["tone"]) =>
  tone === "success" ? "success" : tone === "info" ? "info" : "warning";

const formatDateTime = (date: string): string =>
  date.slice(0, 19).replace("T", " ");

const approvalStatusLabel = (approval: ApprovalDetail): string => {
  if (approval.status === "approved") return "Approved";
  if (approval.status === "rejected") return "Rejected";
  if (approval.status === "pending") return "Pending approval";
  if (approval.status === "cancelled") return "Cancelled";
  return "Expired";
};

const detailRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/**
 * Defensively parse `context.photoSignals` (stamped by the runtime) into
 * the shape the ApprovalCard expects. Returns null for absent/malformed
 * values so a bad row never crashes the ticket page.
 */
const parsePhotoSignals = (
  value: unknown,
): {
  count: number;
  withExif: number;
  stripped: number;
  anyStripped: boolean;
} | null => {
  const r = detailRecord(value);
  if (!r) return null;
  const count = r["count"];
  const withExif = r["withExif"];
  const stripped = r["stripped"];
  const anyStripped = r["anyStripped"];
  if (
    typeof count !== "number" ||
    typeof withExif !== "number" ||
    typeof stripped !== "number" ||
    typeof anyStripped !== "boolean"
  ) {
    return null;
  }
  return { count, withExif, stripped, anyStripped };
};

const parsedBody = (value: unknown): string | null => {
  const body = detailRecord(value)?.["bodyText"];
  return typeof body === "string" && body.trim() ? body : null;
};

const BodyBlock = ({ value }: { readonly value: unknown }) => {
  const body = parsedBody(value);
  return body ? (
    <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-sm">
      {body}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">No parsed body.</p>
  );
};

type SimplifiedTimelineItem =
  | CuratedTimelineItem
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly approval: ApprovalDetail;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "refundRecommendation";
      readonly id: string;
      readonly recommendation: RefundRecommendationSummary;
      readonly occurredAt: string;
    };

const RefundRecommendationBlock = ({
  recommendation,
}: {
  readonly recommendation: RefundRecommendationSummary;
}) => (
  <div className="space-y-2 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={recommendationVariant(recommendation.recommendation)}>
        {RECOMMENDATION_LABEL[recommendation.recommendation]}
      </Badge>
      {recommendation.amount ? (
        <span className="font-mono text-xs text-muted-foreground">
          {recommendation.amount.amount} {recommendation.amount.currencyCode}
        </span>
      ) : null}
    </div>
    {recommendation.reasoning ? (
      <p className="text-muted-foreground">{recommendation.reasoning}</p>
    ) : null}
    {recommendation.riskFlags.length > 0 ? (
      <div className="flex flex-wrap gap-1.5">
        {recommendation.riskFlags.map((flag) => (
          <Badge
            key={flag}
            variant="outline"
            className="font-mono text-[10px] uppercase tracking-wider"
          >
            {flag}
          </Badge>
        ))}
      </div>
    ) : null}
  </div>
);

const PRODUCT_MATCH_LABEL: Record<"match" | "mismatch" | "uncertain", string> = {
  match: "Photos match item",
  mismatch: "Photos may not match item",
  uncertain: "Photo match uncertain",
};

/**
 * Compact decision signals shown above the composer while a single reply draft
 * awaits approval — the agent's recommendation, photo check, return intent, and
 * any risk flags — so the manager approves the prose with context. The full
 * editable review still lives at `/approvals/[id]`.
 */
const ApprovalSignalsStrip = ({
  approvalId,
  recommendation,
  productMatch,
  riskFlags,
  returnReason,
  requestedResolution,
}: {
  readonly approvalId: string;
  readonly recommendation: RefundRecommendationSummary | null;
  readonly productMatch: "match" | "mismatch" | "uncertain" | null;
  readonly riskFlags: ReadonlyArray<string>;
  readonly returnReason: ReturnReason | null;
  readonly requestedResolution: RequestedResolution | null;
}) => (
  <div className="mb-2 flex flex-wrap items-center gap-1.5">
    <span className="text-[11px] font-semibold uppercase tracking-wider text-warning">
      Awaiting your approval
    </span>
    {recommendation ? (
      <Badge
        variant={recommendationVariant(recommendation.recommendation)}
        className="text-xs"
      >
        {RECOMMENDATION_LABEL[recommendation.recommendation]}
        {recommendation.amount
          ? ` · ${recommendation.amount.amount} ${recommendation.amount.currencyCode}`
          : ""}
      </Badge>
    ) : null}
    {productMatch ? (
      <Badge
        variant={
          productMatch === "match"
            ? "success"
            : productMatch === "mismatch"
              ? "destructive"
              : "outline"
        }
        className="text-xs"
      >
        {PRODUCT_MATCH_LABEL[productMatch]}
      </Badge>
    ) : null}
    {requestedResolution ? (
      <Badge variant="outline" className="text-xs">
        Wants: {requestedResolutionLabel(requestedResolution)}
      </Badge>
    ) : null}
    {returnReason ? (
      <Badge variant="outline" className="text-xs">
        {returnReasonLabel(returnReason)}
      </Badge>
    ) : null}
    {riskFlags.map((flag) => (
      <Badge key={flag} variant="destructive" className="text-xs">
        {riskFlagLabel(flag)}
      </Badge>
    ))}
    <Link
      href={`/approvals/${approvalId}`}
      className="text-xs text-primary hover:underline"
    >
      Full review
    </Link>
  </div>
);

const customerFullName = (c: ShopifyCustomer | null): string | null => {
  if (!c) return null;
  const parts = [c.firstName, c.lastName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
};

/** Icon-only action button backed by a one-field server-action form. */
const ActionFormButton = ({
  ticketId,
  action,
  title,
  pendingLabel,
  variant = "outline",
  children,
}: {
  readonly ticketId: string;
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly title: string;
  readonly pendingLabel: string;
  readonly variant?: "outline" | "success" | "default";
  readonly children: ReactNode;
}) => (
  <form action={action}>
    <input type="hidden" name="ticketId" value={ticketId} />
    <SubmitButton
      size="icon"
      variant={variant}
      pendingLabel={pendingLabel}
      aria-label={title}
      title={title}
    >
      {children}
    </SubmitButton>
  </form>
);

export default async function TicketDetailPage({ params, searchParams }: Params) {
  const { id } = await params;
  const sp = await searchParams;
  const showFullAudit = sp.timeline === "full";
  const banner =
    takeOverBanner(sp.takenOver) ??
    resumeBanner(sp.resumed) ??
    retryBanner(sp.retried) ??
    retrySendBanner(sp.retrySend) ??
    replyBanner(sp.replied) ??
    statusChangedBanner(sp.statusChanged) ??
    ticketResolvedBanner(sp.ticketResolved) ??
    refundIssuedBanner(sp.refundIssued) ??
    detailsEditedBanner(sp.detailsEdited, sp.orderResolved) ??
    approvalBanner(sp);
  const ctx = await getDashboardContext();
  const [detail, shopify, conversationThread, trackingResult] =
    await Promise.all([
      api.ticketDetail(ctx, id),
      api.ticketShopify(ctx, id),
      api.ticketConversationThread(ctx, id),
      api.ticketTracking(ctx, id),
    ]);
  if (!detail) notFound();
  const ticketRow = detail.ticket;
  const entries = detail.auditEntries;
  const allApprovals = detail.approvals;
  const customer = shopify?.customer ?? null;
  const order = shopify?.order ?? null;
  const shopDomain = shopify?.shopDomain ?? null;

  const context = (ticketRow.context ?? {}) as Readonly<Record<string, unknown>>;
  const customerEmail =
    typeof context["customerEmail"] === "string"
      ? (context["customerEmail"] as string)
      : null;
  const verifiedOrderEmail =
    typeof context["verifiedCustomerEmail"] === "string"
      ? (context["verifiedCustomerEmail"] as string)
      : null;
  const orderHint =
    typeof context["identifiedOrderId"] === "string"
      ? (context["identifiedOrderId"] as string)
      : typeof context["quotedOrderRef"] === "string"
        ? (context["quotedOrderRef"] as string)
        : null;
  const productMatch =
    context["productMatch"] === "match" ||
    context["productMatch"] === "mismatch" ||
    context["productMatch"] === "uncertain"
      ? context["productMatch"]
      : null;
  const photoSignals = parsePhotoSignals(context["photoSignals"]);
  const riskFlags = Array.isArray(context["riskFlags"])
    ? (context["riskFlags"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];
  const returnReason = parseReturnReason(context["returnReason"]);
  const requestedResolution = parseRequestedResolution(
    context["requestedResolution"],
  );
  const approvalNote = approvalDisplayNote(context);
  // Prefer the fresh live lookup (rich: origin/destination, transit days, full
  // checkpoint history); fall back to the on-ticket `liveTrackingStatus` stamp.
  const liveTracking =
    trackingResult.kind === "ok"
      ? parseLiveTracking(trackingResult.tracking)
      : null;
  const tracking = liveTracking ?? parseLiveTracking(context["liveTrackingStatus"]);

  // The conversation's display name: the linked Shopify customer, else the
  // inbound sender's name from the thread, else the reply-to email.
  const threadInboundName =
    conversationThread?.status === "available"
      ? (conversationThread.thread.messages.find(
          (m) => m.direction === "inbound",
        )?.from.name ?? null)
      : null;
  // Re-pins the chat to the bottom whenever the newest message changes.
  const threadKey =
    conversationThread?.status === "available"
      ? `${conversationThread.thread.messages.length}:${
          conversationThread.thread.messages.at(-1)?.id ?? ""
        }`
      : "none";
  const customerName =
    customerFullName(customer) ??
    threadInboundName ??
    customerEmail ??
    "Customer";

  // Prefilled values for the "edit details" pencils — the merchant edits from
  // what's already known (empty when the agent found nothing). The order field
  // shows the human-friendly name/ref, never a raw GID.
  const contextCustomerName =
    typeof context["customerName"] === "string"
      ? (context["customerName"] as string)
      : null;
  const editCustomerNameDefault =
    contextCustomerName ?? customerFullName(customer) ?? threadInboundName ?? "";
  const editCustomerEmailDefault = customerEmail ?? customer?.email ?? "";
  const editCustomerPhoneDefault =
    (typeof context["customerPhone"] === "string"
      ? (context["customerPhone"] as string)
      : null) ??
    customer?.phone ??
    "";
  const editOrderRefDefault =
    order?.name ??
    (typeof context["quotedOrderRef"] === "string"
      ? (context["quotedOrderRef"] as string)
      : "");

  const canTakeOver = !TERMINAL.has(ticketRow.status);
  const canResume = ticketRow.status === "human_takeover";
  const canResolve = !RESOLVE_HIDDEN.has(ticketRow.status);
  // The statuses a person may move this ticket to by hand (matrix-validated).
  // Folded into the ⋮ menu (no header dropdown); `resolved` is omitted because
  // the dedicated ✓ Resolve button is the canonical close (it also works from
  // takeover, which the plain status path forbids).
  const statusTargets = allowedManualStatusTargets(ticketRow.status as TicketStatus);
  const statusMenuItems: TicketMenuAction[] = statusTargets
    .filter((s) => s !== "resolved")
    .map((s) => ({
      key: `status-${s}`,
      label: STATUS_MENU_LABEL[s]?.label ?? `Mark as ${ticketStatusLabel(s)}`,
      pendingLabel: "Updating…",
      title: STATUS_MENU_LABEL[s]?.title ?? `Set status to ${ticketStatusLabel(s)}`,
      ticketId: ticketRow.id,
      action: setStatusAction,
      fields: { status: s },
    }));
  const menuActions: TicketMenuAction[] = [
    ...statusMenuItems,
    ...ticketActionMenuItems({ canResume }).map((item) => ({
      ...item,
      ticketId: ticketRow.id,
      action: TICKET_MENU_ACTIONS[item.key],
    })),
  ];
  const pendingApprovals = allApprovals
    .filter((approval) => approval.status === "pending")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // The reply composer's model picker is fetched whenever a composer that can
  // rephrase will render (taken over, or a draft is awaiting approval), and
  // tolerantly (null when the member can't read the catalog).
  const replyModels =
    canResume || pendingApprovals.length >= 1
      ? await api.replyModels(ctx)
      : null;
  const showRetrySend = shouldShowRetrySendAction({
    ticketStatus: ticketRow.status,
    activeReplyDelivery: detail.activeReplyDelivery,
    riskFlags,
  });
  const refundToIssue = issuableRefund(entries);
  const refundableOrder =
    order && order.financialStatus !== "refunded" ? order : null;
  const summaryText =
    ticketRow.summary ??
    (typeof context["notes"] === "string" ? context["notes"] : null);
  const timelineHref = (mode: "full" | "simplified") =>
    buildTicketTimelineHref(ticketRow.id, sp, mode);

  // Composer state. A single reply draft awaiting approval fills the input with
  // Approve/Reject; a bundle or a non-reply approval keeps its richer card; a
  // taken-over ticket lets the manager reply by hand; otherwise it's locked.
  const singleApproval =
    pendingApprovals.length === 1 ? pendingApprovals[0]! : null;
  const singleApprovalDraft =
    singleApproval &&
    singleApproval.proposedInput &&
    typeof singleApproval.proposedInput === "object" &&
    typeof (singleApproval.proposedInput as Record<string, unknown>)[
      "bodyText"
    ] === "string"
      ? ((singleApproval.proposedInput as Record<string, unknown>)[
          "bodyText"
        ] as string)
      : null;
  // Concurrent wait states: a ticket parked waiting_for_approval can ALSO carry
  // an open supplier escalation (status shows the primary wait). Key the
  // supplier facts off the row-derived flag, falling back to status for an
  // older api that doesn't send waitingOn.
  const waitingOnSupplier =
    ticketRow.waitingOn?.supplier ?? ticketRow.status === "waiting_for_supplier";
  const lockedMessage =
    ticketRow.status === "resolved" || ticketRow.status === "archived"
      ? "This ticket is closed. Reopen it from the status menu to reply."
      : ticketRow.status === "failed"
        ? "This ticket is closed. Reopen it from the status menu to reply."
        : waitingOnSupplier
          ? "Waiting on the supplier. Take over to reply to the customer."
          : "The agent is handling this conversation. Take over to reply yourself.";
  const composerMode: ComposerMode | null =
    singleApproval && singleApprovalDraft !== null
      ? {
          kind: "approval",
          approvalId: singleApproval.id,
          draftBody: singleApprovalDraft,
          returnTo: `/tickets/${ticketRow.id}`,
        }
      : pendingApprovals.length > 1 || singleApproval
        ? null // rendered as BundleApprovalBar / ApprovalCard below
        : canResume
          ? { kind: "reply" }
          : { kind: "locked", message: lockedMessage };

  const recommendationTimelineItems: SimplifiedTimelineItem[] = entries.flatMap(
    (entry) => {
      const recommendation = refundRecommendationFromEntry(entry);
      return recommendation
        ? [
            {
              kind: "refundRecommendation" as const,
              id: `refund-recommendation-${entry.id}`,
              recommendation,
              occurredAt: entry.occurredAt,
            },
          ]
        : [];
    },
  );
  const failedDeliveryItem = replyDeliveryFailedTimelineItem({
    ticketStatus: ticketRow.status,
    activeReplyDelivery: detail.activeReplyDelivery,
    riskFlags,
  });
  const simplifiedTimelineItems: SimplifiedTimelineItem[] = [
    ...entries
      .map((entry) => curatedTimelineEvent(entry, customerEmail))
      .filter((item): item is CuratedTimelineItem => item !== null),
    ...recommendationTimelineItems,
    ...(failedDeliveryItem ? [failedDeliveryItem] : []),
    ...allApprovals.map((approval) => ({
      kind: "approval" as const,
      id: `approval-${approval.id}`,
      approval,
      occurredAt: approval.createdAt,
    })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return (
    <div className="flex h-full min-h-0">
      {/* CENTER — conversation */}
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card py-2.5 pl-4 pr-4 group-data-[sidebar-state=collapsed]/ticket:pl-14">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {customerName}
              </h1>
              <TicketLiveBoundary
                ticketId={ticketRow.id}
                initialSince={
                  entries.length > 0 ? entries[entries.length - 1]!.id : "0"
                }
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant={ticketStatusVariant(ticketRow.status)}
                className="px-1.5 py-0"
              >
                {ticketStatusLabel(ticketRow.status)}
              </Badge>
              {/* Concurrent wait: show the OTHER wait(s) as a second chip when
                  they hold but aren't already the status badge. */}
              {extraWaitChips(ticketRow.status, ticketRow.waitingOn).map((s) => (
                <Badge
                  key={s}
                  variant={ticketStatusVariant(s)}
                  className="px-1.5 py-0"
                >
                  {ticketStatusLabel(s)}
                </Badge>
              ))}
              <span>·</span>
              <span>
                {ticketRow.scenarioKey ? humanizeSlug(ticketRow.scenarioKey) : "Uncategorized"}
              </span>
              {customerEmail && customerEmail !== customerName ? (
                <>
                  <span>·</span>
                  <span className="truncate">{customerEmail}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {canResolve ? (
              <ActionFormButton
                ticketId={ticketRow.id}
                action={resolveAction}
                title="Resolve this ticket"
                pendingLabel=""
                variant="success"
              >
                <Check aria-hidden />
              </ActionFormButton>
            ) : null}
            {canTakeOver ? (
              <ActionFormButton
                ticketId={ticketRow.id}
                action={takeOverAction}
                title="Take over — handle this ticket manually"
                pendingLabel=""
              >
                <Hand aria-hidden />
              </ActionFormButton>
            ) : null}
            {canResume ? (
              <>
                {showRetrySend ? (
                  <ActionFormButton
                    ticketId={ticketRow.id}
                    action={retrySendAction}
                    title="Retry sending the failed reply"
                    pendingLabel=""
                  >
                    <RefreshCw aria-hidden />
                  </ActionFormButton>
                ) : null}
                <ActionFormButton
                  ticketId={ticketRow.id}
                  action={resumeAction}
                  title="Hand back to the agent"
                  pendingLabel=""
                >
                  <Bot aria-hidden />
                </ActionFormButton>
              </>
            ) : null}
            {refundableOrder ? (
              <RefundDialog
                compact
                ticketId={ticketRow.id}
                orderName={refundableOrder.name}
                loadContext={loadRefundContextAction}
                issueAction={issueRefundAction}
              />
            ) : null}
            <TicketActionsMenu actions={menuActions} />
          </div>
        </header>

        {banner ? (
          <div className="shrink-0 px-4 pt-3">
            <div className="mx-auto w-full max-w-3xl">
              <Alert variant={toneToVariant(banner.tone)}>
                <AlertDescription>{banner.text}</AlertDescription>
              </Alert>
            </div>
          </div>
        ) : null}

        <ChatScrollArea
          bottomKey={threadKey}
          className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-6"
        >
          <div className="mx-auto w-full max-w-3xl">
            <ChatThread
              result={
                conversationThread ?? { status: "unavailable", reason: "no_thread" }
              }
            />
          </div>
        </ChatScrollArea>

        <div className="thin-scrollbar max-h-[60%] shrink-0 overflow-y-auto border-t border-border/60 bg-card px-4 py-3">
          <div className="mx-auto w-full max-w-3xl">
          {composerMode ? (
            <>
              {composerMode.kind === "approval" ? (
                <ApprovalSignalsStrip
                  approvalId={composerMode.approvalId}
                  recommendation={extractRefundRecommendation(entries)}
                  productMatch={productMatch}
                  riskFlags={riskFlags}
                  returnReason={returnReason}
                  requestedResolution={requestedResolution}
                />
              ) : null}
              <ChatComposer
                ticketId={ticketRow.id}
                customerEmail={customerEmail}
                models={replyModels}
                mode={composerMode}
              />
            </>
          ) : pendingApprovals.length > 1 ? (
            <BundleApprovalBar ticketId={ticketRow.id} pending={pendingApprovals} />
          ) : singleApproval ? (
            <ApprovalCard
              approval={singleApproval}
              returnTo={`/tickets/${ticketRow.id}`}
              refundRecommendation={extractRefundRecommendation(entries)}
              productMatch={productMatch}
              photoSignals={photoSignals}
              riskFlags={riskFlags}
              returnReason={returnReason}
              requestedResolution={requestedResolution}
              note={approvalNote}
            />
          ) : null}
          </div>
        </div>
      </section>

      {/* RIGHT — customer, order, context & timeline (static column on lg+,
          off-canvas drawer on smaller screens) */}
      <TicketDetailsPanel>
        <div className="space-y-4 p-4">
          <CustomerPanel
            customer={customer}
            customerEmail={customerEmail}
            verifiedOrderEmail={verifiedOrderEmail}
            headerAction={
              <CardEditPopover
                ticketId={ticketRow.id}
                action={editTicketDetailsAction}
                label="Edit customer"
                title="Edit customer"
                description="Set the customer the agent couldn't identify. We look them up by email, then phone, then name."
                fields={[
                  {
                    name: "customerName",
                    label: "Name",
                    placeholder: "Jane Shopper",
                    defaultValue: editCustomerNameDefault,
                  },
                  {
                    name: "customerEmail",
                    label: "Email",
                    type: "email",
                    placeholder: "jane@example.com",
                    defaultValue: editCustomerEmailDefault,
                  },
                  {
                    name: "customerPhone",
                    label: "Phone",
                    type: "tel",
                    placeholder: "+1 555 123 4567",
                    defaultValue: editCustomerPhoneDefault,
                  },
                ]}
              />
            }
          />
          <OrderPanel
            order={order}
            orderHint={orderHint}
            shopDomain={shopDomain}
            headerAction={
              <CardEditPopover
                ticketId={ticketRow.id}
                action={editTicketDetailsAction}
                label="Assign order"
                title="Assign order"
                description="Enter the order number or confirmation code to link it to this ticket."
                fields={[
                  {
                    name: "orderRef",
                    label: "Order number",
                    placeholder: "#1001",
                    defaultValue: editOrderRefDefault,
                  },
                ]}
              />
            }
          />

          {tracking ? (
            <TrackingPanel
              tracking={tracking}
              destinationCountry={order?.shippingAddress?.country ?? null}
              orderPlacedAt={order?.createdAt ?? null}
            />
          ) : null}

          {refundToIssue ? (
            <Card className="border-primary/40 bg-primary/5">
              <CardContent className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    Agent recommended a refund
                  </span>
                  <Badge
                    variant={recommendationVariant(refundToIssue.recommendation)}
                    className="text-xs"
                  >
                    {RECOMMENDATION_LABEL[refundToIssue.recommendation]}
                  </Badge>
                  <span className="font-mono text-sm">
                    {refundToIssue.amount!.amount}{" "}
                    {refundToIssue.amount!.currencyCode}
                  </span>
                </div>
                {refundToIssue.reasoning ? (
                  <p className="text-sm text-muted-foreground">
                    {refundToIssue.reasoning}
                  </p>
                ) : null}
                <form action={issueRefundAction}>
                  <input type="hidden" name="ticketId" value={ticketRow.id} />
                  <input
                    type="hidden"
                    name="amount"
                    value={refundToIssue.amount!.amount}
                  />
                  <input
                    type="hidden"
                    name="currencyCode"
                    value={refundToIssue.amount!.currencyCode}
                  />
                  <ConfirmSubmitButton
                    variant="default"
                    title="Issue this refund?"
                    description={`This moves real money: ${refundToIssue.amount!.amount} ${refundToIssue.amount!.currencyCode} is refunded to the customer's original payment method and Shopify emails them the confirmation. This can't be undone from here.`}
                    confirmLabel="Issue refund"
                  >
                    Issue refund
                  </ConfirmSubmitButton>
                </form>
              </CardContent>
            </Card>
          ) : null}

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context
            </h2>
            <TicketContext context={context} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Timeline
              </h2>
              <div className="flex gap-1">
                <Button
                  asChild
                  size="sm"
                  variant={!showFullAudit ? "default" : "outline"}
                >
                  <Link href={timelineHref("simplified")}>Activity</Link>
                </Button>
                <Button
                  asChild
                  size="sm"
                  variant={showFullAudit ? "default" : "outline"}
                >
                  <Link href={timelineHref("full")}>Audit</Link>
                </Button>
              </div>
            </div>

            {showFullAudit ? (
              <ol className="relative">
                {entries.map((e) => (
                  <li
                    key={e.id}
                    className="relative ml-2 border-l-2 border-border pb-3 pl-5 last:pb-0"
                  >
                    <span className="absolute -left-[5px] top-3 size-2 rounded-full bg-primary" />
                    <Card>
                      {refundRecommendationFromEntry(e) ? (
                        <CardContent className="space-y-3 p-4">
                          <div className="text-sm font-medium">
                            Refund recommendation
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {e.actorType}
                            {e.actorId ? ` · ${e.actorId}` : ""} ·{" "}
                            {formatDateTime(e.occurredAt)}
                          </div>
                          <RefundRecommendationBlock
                            recommendation={refundRecommendationFromEntry(e)!}
                          />
                        </CardContent>
                      ) : (
                        <CardContent className="space-y-1.5 p-4">
                          <div className="text-sm font-medium">
                            {auditActionLabel(e.action)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {e.actorType}
                            {e.actorId ? ` · ${e.actorId}` : ""} ·{" "}
                            {formatDateTime(e.occurredAt)}
                          </div>
                          {e.details ? (
                            <pre className="overflow-auto rounded-md bg-muted/50 p-2 text-xs">
                              {JSON.stringify(e.details, null, 2)}
                            </pre>
                          ) : null}
                        </CardContent>
                      )}
                    </Card>
                  </li>
                ))}
              </ol>
            ) : summaryText || simplifiedTimelineItems.length > 0 ? (
              <div className="space-y-3">
                {summaryText ? (
                  <Card>
                    <CardContent className="space-y-1.5 p-4">
                      <div className="text-sm font-medium">
                        {ticketRow.summary ? "Summary" : "Triage notes"}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {summaryText}
                      </p>
                    </CardContent>
                  </Card>
                ) : null}

                <ol className="relative">
                  {simplifiedTimelineItems.map((item) => (
                    <li
                      key={item.id}
                      className="relative ml-2 border-l-2 border-border pb-3 pl-5 last:pb-0"
                    >
                      <span
                        className={cn(
                          "absolute -left-[5px] top-3 size-2 rounded-full",
                          item.kind === "deliveryFailed"
                            ? "bg-destructive"
                            : "bg-primary",
                        )}
                      />
                      <Card
                        className={
                          item.kind === "deliveryFailed"
                            ? "border-destructive"
                            : undefined
                        }
                      >
                        {item.kind === "email" ? (
                          <CardContent className="space-y-1.5 p-4">
                            <div className="text-sm font-medium">{item.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {item.responsible} · {formatDateTime(item.occurredAt)}
                            </div>
                          </CardContent>
                        ) : item.kind === "note" ? (
                          <CardContent className="space-y-1.5 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                {item.title}
                              </div>
                              <Badge variant="outline">Heads-up to you</Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.delivered === false
                                ? "Not delivered — no notification channel connected"
                                : "Sent to your notification channel"}{" "}
                              · {formatDateTime(item.occurredAt)}
                            </div>
                            {item.message ? (
                              <p className="break-words text-sm text-muted-foreground">
                                {item.message}
                              </p>
                            ) : null}
                          </CardContent>
                        ) : item.kind === "status" ? (
                          <CardContent className="space-y-1.5 p-4">
                            <div className="text-sm font-medium">{item.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {formatDateTime(item.occurredAt)}
                            </div>
                            {item.description ? (
                              <p className="break-words text-sm text-muted-foreground">
                                {item.description}
                              </p>
                            ) : null}
                          </CardContent>
                        ) : item.kind === "refundRecommendation" ? (
                          <CardContent className="space-y-3 p-4">
                            <div className="text-sm font-medium">
                              Refund recommendation
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Agent assessment · {formatDateTime(item.occurredAt)}
                            </div>
                            <RefundRecommendationBlock
                              recommendation={item.recommendation}
                            />
                          </CardContent>
                        ) : item.kind === "deliveryFailed" ? (
                          <CardContent className="space-y-2 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium text-destructive">
                                {item.title}
                              </div>
                              <Badge variant="destructive">Not delivered</Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDateTime(item.occurredAt)}
                            </div>
                            <p className="break-words text-sm text-muted-foreground">
                              The drafted reply couldn&apos;t be sent to the
                              customer.
                              {item.lastError
                                ? ` Last error: ${item.lastError}`
                                : ""}
                            </p>
                            <form action={retrySendAction} className="pt-1">
                              <input
                                type="hidden"
                                name="ticketId"
                                value={ticketRow.id}
                              />
                              <SubmitButton
                                size="sm"
                                pendingLabel="Re-sending…"
                                title="Re-send the same drafted reply that failed to deliver to the customer"
                              >
                                Retry sending email
                              </SubmitButton>
                            </form>
                          </CardContent>
                        ) : (
                          <CardContent className="space-y-3 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                {approvalStatusLabel(item.approval)}
                              </div>
                              <Badge variant="outline">
                                {toolActionLabel(item.approval.tool)}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Agent {item.approval.agentId} ·{" "}
                              {formatDateTime(item.approval.createdAt)}
                              {item.approval.decidedAt
                                ? ` · decided ${formatDateTime(
                                    item.approval.decidedAt,
                                  )}`
                                : ""}
                            </div>
                            {item.approval.reasoning ? (
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-muted-foreground">
                                  Reason
                                </div>
                                <p className="text-sm">{item.approval.reasoning}</p>
                              </div>
                            ) : null}
                            {item.approval.decisionReason ? (
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-muted-foreground">
                                  Decision reason
                                </div>
                                <p className="text-sm">
                                  {item.approval.decisionReason}
                                </p>
                              </div>
                            ) : null}
                            <div className="space-y-1">
                              <div className="text-xs font-medium text-muted-foreground">
                                Proposed message
                              </div>
                              <BodyBlock value={item.approval.proposedInput} />
                            </div>
                          </CardContent>
                        )}
                      </Card>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
                No activity to show yet.
              </p>
            )}
          </div>
        </div>
      </TicketDetailsPanel>
    </div>
  );
}

/**
 * What the agent has figured out about the ticket so far — order, customer,
 * reason, risk flags — as a labeled field list instead of a raw JSON blob.
 * The row-building lives in `ticket-context.ts` (pure + unit-tested); this only
 * paints them.
 */
function TicketContext({
  context,
}: {
  readonly context: Readonly<Record<string, unknown>>;
}) {
  const rows = buildContextRows(context);
  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        Nothing recorded yet.
      </p>
    );
  }
  return (
    <dl className="divide-y divide-border overflow-hidden rounded-md border bg-card">
      {rows.map((row) => (
        <div key={row.key} className="px-3 py-2.5">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.label}
          </dt>
          <dd className="mt-0.5 min-w-0 text-sm text-foreground">
            {row.badges ? (
              <div className="flex flex-wrap gap-1.5">
                {row.badges.map((b, i) => (
                  <Badge key={`${row.key}-${i}`} variant={b.variant}>
                    {b.text}
                  </Badge>
                ))}
              </div>
            ) : (
              <span
                className={cn(
                  row.mono && "break-all font-mono text-[13px]",
                  row.multiline && "whitespace-pre-wrap",
                )}
              >
                {row.text}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
