import { useLayoutEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";

import type { ApprovalDetail } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { ApiError } from "@/lib/errors";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { usePathname } from "@/lib/navigation";
import { ticketIdFromPathname } from "@/lib/tickets-sidebar-data";
import { cn } from "@/lib/utils";
import {
  ticketStatusLabel,
  humanizeSlug,
  toolActionLabel,
} from "@/lib/labels";
import { ticketStatusVariant } from "@/lib/status-variants";
import { extraWaitChips } from "@/lib/waiting-chips";
import {
  approvedNotSentTimelineItem,
  curatedTimelineEvent,
  replyDeliveryFailedTimelineItem,
  type CuratedTimelineItem,
} from "@/lib/ticket-timeline";
import {
  RECOMMENDATION_LABEL,
  extractRefundRecommendation,
  issuableRefund,
  recommendationVariant,
  refundRecommendationFromEntry,
  type RefundRecommendationSummary,
} from "@/lib/refund-recommendation";
import {
  parseRequestedResolution,
  parseReturnReason,
} from "@/lib/return-labels";
import {
  buildContextCardRows,
  type ContextBadge,
  type ContextRow,
} from "@/lib/ticket-context";
import { approvalDisplayNote } from "@/lib/approval-note";
import {
  dropSupersededStamp,
  parseLiveTracking,
} from "@/lib/tracking-panel-data";
import { shouldShowRetrySendAction } from "@/lib/retry-send-visibility";
import { composerKey } from "@/lib/composer-key";
import { isTicketProcessing } from "@/lib/ticket-processing";
import {
  addressEditDisabledReason,
  cancelOrderDisabledReason,
} from "@/lib/order-panel-data";
import { Link } from "@/components/ui/link";
import { AnimateHeight } from "@/components/ui/animate-height";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ChatThread } from "./ChatThread";
import { ChatScrollArea } from "./ChatScrollArea";
import { TicketDetailsPanel } from "./TicketDetailsPanel";
import { TicketHeaderActions } from "./TicketHeaderActions";
import { TicketLiveBoundary } from "./TicketLiveBoundary";
import { ChatComposer } from "./ChatComposer";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalSignalsStrip } from "./ApprovalSignalsStrip";
import { BundleApprovalBar } from "./BundleApprovalBar";
import { IssueRefundCard } from "./IssueRefundCard";
import { RefundDialog } from "./RefundDialog";
import { CancelOrderDialog } from "./CancelOrderDialog";
import { RetrySendButton } from "./RetrySendButton";
import { ResendApprovalButton } from "./ResendApprovalButton";
import { CustomerPanel } from "./CustomerPanel";
import { OrderPanel } from "./OrderPanel";
import { CardEditPopover } from "./CardEditPopover";
import { TrackingPanel } from "./TrackingPanel";
import { TicketDetailLoading } from "./TicketDetailLoading";

// ⚠️ Phase 3 = READ-ONLY. This is the SPA port of the Next ticket-detail page's
// display: the conversation thread, the customer/order/tracking panels, the
// ticket context, and the activity/audit timeline. The interactive surface —
// composer, approve/reject, take-over/resume/resolve, refund dialog, the ⋮
// actions menu, and the live-refresh boundary — lands in Phase 4/5. The read-
// only derivations + timeline assembly mirror the Next page 1:1.

// UI-visibility gates for the header actions (NOT the §10 transition matrix —
// the api enforces the real rules; these just decide which buttons to show).
const TERMINAL = new Set(["resolved", "archived", "human_takeover", "failed"]);
const RESOLVE_HIDDEN = new Set([
  "resolved",
  "archived",
  "failed",
  "waiting_for_approval",
  "waiting_for_fulfillment_operator",
  "approved_action_running",
]);

const formatDateTime = (date: string): string =>
  date.slice(0, 19).replace("T", " ");

const detailRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const parsedBody = (value: unknown): string | null => {
  const body = detailRecord(value)?.["bodyText"];
  return typeof body === "string" && body.trim() ? body : null;
};

// Defensively parse `context.photoSignals` (stamped by the runtime) for the
// ApprovalCard; null for absent/malformed values so a bad row never crashes.
const parsePhotoSignals = (
  value: unknown,
): {
  readonly count: number;
  readonly withExif: number;
  readonly stripped: number;
  readonly anyStripped: boolean;
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

const approvalTimelineLabel = (approval: ApprovalDetail): string => {
  if (approval.status === "approved") return "Approved";
  if (approval.status === "rejected") return "Rejected";
  if (approval.status === "pending") return "Pending approval";
  if (approval.status === "cancelled") return "Cancelled";
  return "Expired";
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
            className="font-mono text-[0.625rem] uppercase tracking-wider"
          >
            {flag}
          </Badge>
        ))}
      </div>
    ) : null}
  </div>
);

// A short, stable handle for a ticket id in a chip/link — the full id (a long
// opaque token) would blow out the narrow card.
const shortTicketId = (id: string): string => `#${id.slice(0, 8)}`;

function TicketLink({ id }: { readonly id: string }) {
  return (
    <Link
      href={`/tickets/${id}`}
      className="font-medium text-inherit underline decoration-1 underline-offset-2 hover:decoration-2"
    >
      {shortTicketId(id)}
    </Link>
  );
}

// One risk-flag / evidence chip in the context card. Duplicate-photo chips carry
// the matched ticket ids: a single one is linked inline; several collapse into a
// counted chip with a hover tooltip listing every linked ticket. Plain-text
// chips truncate to keep the card narrow, revealing the full label on hover only
// when it actually overflows.
function ContextChip({ badge }: { readonly badge: ContextBadge }) {
  const ids = badge.ticketIds ?? [];

  if (ids.length === 1 && ids[0]) {
    return (
      <Badge variant={badge.variant} className="min-w-0 max-w-full">
        <span className="min-w-0 truncate">{badge.text}</span>
        <span className="ms-1 shrink-0">
          <TicketLink id={ids[0]} />
        </span>
      </Badge>
    );
  }

  if (ids.length > 1) {
    return (
      <Tooltip
        content={
          <ul className="flex flex-col gap-1">
            {ids.map((id) => (
              <li key={id}>
                <TicketLink id={id} />
              </li>
            ))}
          </ul>
        }
      >
        <Badge
          variant={badge.variant}
          className="min-w-0 max-w-full cursor-default"
        >
          <span className="min-w-0 truncate">{badge.text}</span>
        </Badge>
      </Tooltip>
    );
  }

  return <TruncatingChip badge={badge} />;
}

// A plain-text chip that shows its full label in a tooltip only when the text is
// clipped by the card's width (measured after layout).
function TruncatingChip({ badge }: { readonly badge: ContextBadge }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el) setOverflowing(el.scrollWidth > el.clientWidth + 1);
  }, [badge.text]);

  const chip = (
    <Badge variant={badge.variant} className="min-w-0 max-w-full">
      <span ref={textRef} className="min-w-0 truncate">
        {badge.text}
      </span>
    </Badge>
  );

  return overflowing ? <Tooltip content={badge.text}>{chip}</Tooltip> : chip;
}

// Rendered inside the floating context card, which owns the border/background
// chrome — this is just the divided row list. The page computes the rows
// (buildContextCardRows) and skips the whole card when there are none.
function TicketContext({
  rows,
}: {
  readonly rows: ReadonlyArray<ContextRow>;
}) {
  return (
    <dl className="divide-y divide-border">
      {rows.map((row) => (
        <div key={row.key} className="py-2.5 first:pt-0 last:pb-0">
          <dt className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {row.label}
          </dt>
          <dd className="mt-0.5 min-w-0 text-sm text-foreground">
            {row.skeleton ? (
              <Skeleton className="h-4 w-28" />
            ) : row.badges ? (
              <div className="flex flex-wrap gap-1.5">
                {row.badges.map((b, i) => (
                  <ContextChip key={`${row.key}-${i}`} badge={b} />
                ))}
              </div>
            ) : (
              <span
                className={cn(
                  row.mono && "break-all font-mono text-[0.8125rem]",
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

export function TicketDetailPage() {
  const ctx = useWorkspaceCtx();
  const { permissions } = useSession();
  const pathname = usePathname() ?? "";
  const id = ticketIdFromPathname(pathname) ?? "";
  // The floating context card pushes the chat column ~320px narrower, so it
  // only starts open where there's room (≥2xl); smaller screens keep the
  // header toggle.
  const [contextOpen, setContextOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1536,
  );

  const detailQuery = useQuery({
    queryKey: qk.ticket(ctx.workspaceId, id),
    queryFn: () => api.ticketDetail(ctx, id),
    enabled: id.length > 0,
  });
  const shopifyQuery = useQuery({
    queryKey: qk.ticketShopify(ctx.workspaceId, id),
    queryFn: () => api.ticketShopify(ctx, id),
    enabled: id.length > 0,
  });
  const threadQuery = useQuery({
    queryKey: qk.ticketThread(ctx.workspaceId, id),
    queryFn: () => api.ticketConversationThread(ctx, id),
    enabled: id.length > 0,
  });
  const trackingQuery = useQuery({
    queryKey: qk.ticketTracking(ctx.workspaceId, id),
    queryFn: () => api.ticketTracking(ctx, id),
    enabled: id.length > 0,
  });
  // The rephrase model picker's catalog — tolerant (null when the member can't
  // read it), so a reply-only member still gets the composer minus the picker.
  const replyModelsQuery = useQuery({
    queryKey: qk.models(ctx.workspaceId),
    queryFn: () => api.replyModels(ctx),
    enabled: id.length > 0,
  });

  // Hand-correct the customer / order the agent couldn't identify (the pencils on
  // the Customer / Order panels). Toasts the outcome + invalidates the ticket so
  // the panels + timeline refresh. Mirrors the Next `editTicketDetailsAction`.
  const qc = useQueryClient();
  const editDetails = useMutation({
    mutationFn: (fields: {
      readonly customerEmail?: string;
      readonly customerName?: string;
      readonly customerPhone?: string;
      readonly orderRef?: string;
    }) => api.editTicketDetails(ctx, id, fields),
    onSuccess: (result) => {
      if (result.kind === "saved") {
        if (result.orderResolved === true) {
          toast.success("Order linked and ticket details updated.");
        } else if (result.orderResolved === false) {
          toast.warning(
            "Saved, but we couldn't find that order in your store. It's recorded on the ticket as a reference.",
          );
        } else {
          toast.success("Ticket details updated.");
        }
      } else if (result.kind === "invalid_email") {
        toast.warning("That doesn't look like a valid email address.");
      } else if (result.kind === "nothing_to_update") {
        toast.info("Nothing to update.");
      } else if (result.kind === "ticket_not_found") {
        toast.warning("Couldn't find that ticket.");
      } else {
        toast.warning("Something went wrong. Please try again.");
      }
      void qc.invalidateQueries({ queryKey: qk.ticket(ctx.workspaceId, id) });
      void qc.invalidateQueries({ queryKey: ["tickets", ctx.workspaceId] });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });
  const submitTicketEdit = (values: Record<string, string>): Promise<void> =>
    editDetails.mutateAsync(values).then(() => undefined);

  // Fix the order's Ship-to (the pencil on the Order card). Unlike the
  // details pencils this WRITES TO THE STORE — the api merges the non-empty
  // fields over the order's current address and updates the real Shopify
  // order. Shopify-side rejections surface as a thrown 502 → onError.
  const editShippingAddress = useMutation({
    mutationFn: (fields: Record<string, string>) =>
      api.editShippingAddress(ctx, id, fields),
    onSuccess: (result) => {
      if (result.kind === "saved") {
        toast.success("Shipping address updated on the order.");
      } else if (result.kind === "order_not_found") {
        toast.warning(
          "No order is linked to this ticket yet. Assign the order first.",
        );
      } else if (result.kind === "nothing_to_update") {
        toast.info("Nothing to update.");
      } else if (result.kind === "ticket_not_found") {
        toast.warning("Couldn't find that ticket.");
      } else {
        toast.warning(
          "Couldn't update the address in your store. Please try again.",
        );
      }
      void qc.invalidateQueries({ queryKey: qk.ticket(ctx.workspaceId, id) });
    },
    onError: (err) =>
      toast.warning(
        err instanceof ApiError && err.status === 403
          ? "You don't have permission to edit orders in this workspace."
          : "Couldn't update the address in your store. Please try again.",
      ),
  });
  const submitShippingAddress = (
    values: Record<string, string>,
  ): Promise<void> =>
    editShippingAddress.mutateAsync(values).then(() => undefined);

  if (detailQuery.isLoading) return <TicketDetailLoading />;

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-sm font-medium">Ticket not found</p>
          <p className="text-sm text-muted-foreground">
            It may have been deleted, or belong to another workspace.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/tickets">Back to tickets</Link>
          </Button>
        </div>
      </div>
    );
  }

  const ticketRow = detail.ticket;
  const entries = detail.auditEntries;
  const allApprovals = detail.approvals;
  const shopify = shopifyQuery.data ?? null;
  const customer = shopify?.customer ?? null;
  const order = shopify?.order ?? null;
  const shopDomain = shopify?.shopDomain ?? null;
  const conversationThread = threadQuery.data ?? null;
  const trackingResult = trackingQuery.data ?? null;

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
  const riskFlags = Array.isArray(context["riskFlags"])
    ? (context["riskFlags"] as unknown[]).filter(
        (f): f is string => typeof f === "string",
      )
    : [];
  // Approval-decision signals (surfaced above the composer + on the ApprovalCard).
  const productMatch =
    context["productMatch"] === "match" ||
    context["productMatch"] === "mismatch" ||
    context["productMatch"] === "uncertain"
      ? context["productMatch"]
      : null;
  const photoSignals = parsePhotoSignals(context["photoSignals"]);
  const returnReason = parseReturnReason(context["returnReason"]);
  const requestedResolution = parseRequestedResolution(
    context["requestedResolution"],
  );
  const approvalNote = approvalDisplayNote(context);

  // The floating card's rows: the customer's ask / evidence / risk / notes,
  // plus the quoted order ref only as a mis-quote heads-up. Empty → no card.
  // While the Shopify lookup is in flight, pass "loading" — not null — so the
  // heads-up row doesn't flash and then pop out once the order arrives.
  const contextCardRows = buildContextCardRows(
    context,
    shopifyQuery.isPending
      ? "loading"
      : order
        ? { name: order.name, confirmationNumber: order.confirmationNumber }
        : null,
  );
  const hasContextCard = contextCardRows.length > 0;
  const showContext = contextOpen && hasContextCard;

  // Prefer the fresh live lookup (rich: origin/destination, transit days, full
  // checkpoint history); fall back to the on-ticket `liveTrackingStatus` stamp —
  // but not one describing a number the order no longer tracks under (a reship
  // or re-label superseded it; the live order's fulfillment is canonical).
  const liveTracking =
    trackingResult?.kind === "ok"
      ? parseLiveTracking(trackingResult.tracking)
      : null;
  const orderTrackingNumbers = (order?.fulfillments ?? []).flatMap(
    (f) => f.trackingNumbers,
  );
  const tracking =
    liveTracking ??
    dropSupersededStamp(
      parseLiveTracking(context["liveTrackingStatus"]),
      orderTrackingNumbers,
      order !== null,
    );

  // The conversation's display name: the linked Shopify customer, else the
  // inbound sender's name from the thread, else the reply-to email.
  const threadInboundName =
    conversationThread?.status === "available"
      ? (conversationThread.thread.messages.find(
          (m) => m.direction === "inbound",
        )?.from.name ?? null)
      : null;
  const threadKey =
    conversationThread?.status === "available"
      ? `${conversationThread.thread.messages.length}:${
          conversationThread.thread.messages.at(-1)?.id ?? ""
        }`
      : "none";
  const customerFullName = (() => {
    if (!customer) return null;
    const parts = [customer.firstName, customer.lastName].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return parts.length > 0 ? parts.join(" ") : null;
  })();
  const customerName =
    customerFullName ?? threadInboundName ?? customerEmail ?? "Customer";

  // Defaults for the edit-customer / assign-order pencils (context override →
  // Shopify record → thread), mirroring the Next page.
  const contextCustomerName =
    typeof context["customerName"] === "string"
      ? (context["customerName"] as string)
      : null;
  const contextCustomerPhone =
    typeof context["customerPhone"] === "string"
      ? (context["customerPhone"] as string)
      : null;
  const contextQuotedOrderRef =
    typeof context["quotedOrderRef"] === "string"
      ? (context["quotedOrderRef"] as string)
      : "";
  const editCustomerNameDefault =
    contextCustomerName ?? customerFullName ?? threadInboundName ?? "";
  const editCustomerEmailDefault = customerEmail ?? customer?.email ?? "";
  const editCustomerPhoneDefault = contextCustomerPhone ?? customer?.phone ?? "";
  const editOrderRefDefault = order?.name ?? contextQuotedOrderRef;

  const pendingApprovals = allApprovals
    .filter((a) => a.status === "pending")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const canTakeOver = !TERMINAL.has(ticketRow.status);
  const canResume = ticketRow.status === "human_takeover";
  const canResolve = !RESOLVE_HIDDEN.has(ticketRow.status);
  const showRetrySend = shouldShowRetrySendAction({
    ticketStatus: ticketRow.status,
    activeReplyDelivery: detail.activeReplyDelivery,
    riskFlags,
  });
  const summaryText =
    ticketRow.summary ??
    (typeof context["notes"] === "string" ? context["notes"] : null);

  // Concurrent wait states: a ticket parked waiting_for_approval can ALSO carry
  // an open fulfillment partner escalation (status shows the primary wait). Key the
  // fulfillmentOperator facts off the row-derived flag, falling back to the status for an
  // older api that doesn't send waitingOn.
  const waitingOnFulfillmentOperator =
    ticketRow.waitingOn?.fulfillmentOperator ?? ticketRow.status === "waiting_for_fulfillment_operator";
  // Manual escalation: hidden while already with the fulfillment partner; `failed` is the
  // one status the state machine refuses to park from.
  const canEscalateFulfillmentOperator = !waitingOnFulfillmentOperator && ticketRow.status !== "failed";

  // "Block sender" needs an address to block AND the blocklist permission
  // (the api derives the address server-side; this only decides visibility).
  const canBlockSender =
    customerEmail !== null && permissions.has("settings.blocked_senders");

  // Why the composer is read-only when the agent owns the conversation.
  const lockedMessage =
    ticketRow.status === "resolved" || ticketRow.status === "archived"
      ? "This ticket is closed. Reopen it from the status menu to reply."
      : ticketRow.status === "failed"
        ? "This ticket is closed. Reopen it from the status menu to reply."
        : waitingOnFulfillmentOperator
          ? "Waiting on the fulfillment partner. Take over to reply to the customer."
          : "The agent is handling this conversation. Take over to reply yourself.";

  // Composer routing: a single reply draft awaiting approval fills the input
  // with Approve/Reject; a bundle or a non-reply approval keeps its richer card;
  // a taken-over ticket lets the manager reply by hand; else it's locked.
  const singleApproval =
    pendingApprovals.length === 1 ? pendingApprovals[0]! : null;
  const singleApprovalProposed = singleApproval
    ? detailRecord(singleApproval.proposedInput)
    : null;
  const singleApprovalDraft =
    singleApprovalProposed && typeof singleApprovalProposed["bodyText"] === "string"
      ? (singleApprovalProposed["bodyText"] as string)
      : null;
  const refundRecommendation = extractRefundRecommendation(entries);
  // The agent's issuable refund recommendation (PATH B), if any.
  const refundToIssue = issuableRefund(entries);
  // Refund and Cancel are offered for ANY linked order — never hidden or
  // disabled on a guess about eligibility (a fully-refunded or already-shipped
  // order still opens its dialog). Shopify is the authority: it refuses what it
  // must, and the failure toast tells the operator plainly that nothing moved.
  // The only condition is that an order is actually linked to the ticket.
  // The Change-address form: prefilled with the order's current address, and
  // submitted whole (`submitEmpty`) so blanking a field CLEARS it.
  const shippingAddressFields = [
    {
      name: "name",
      label: "Recipient",
      placeholder: "Jane Shopper",
      defaultValue: order?.shippingAddress?.name ?? "",
      autoComplete: "name",
    },
    {
      name: "address1",
      label: "Address",
      placeholder: "123 Main St",
      defaultValue: order?.shippingAddress?.address1 ?? "",
      autoComplete: "address-line1",
    },
    {
      name: "address2",
      label: "Apartment, suite, etc.",
      placeholder: "Apt 4B",
      defaultValue: order?.shippingAddress?.address2 ?? "",
      autoComplete: "address-line2",
    },
    {
      name: "city",
      label: "City",
      placeholder: "Brooklyn",
      defaultValue: order?.shippingAddress?.city ?? "",
    },
    {
      name: "province",
      label: "State / Province",
      placeholder: "NY",
      defaultValue: order?.shippingAddress?.province ?? "",
    },
    {
      name: "zip",
      label: "ZIP / Postal code",
      placeholder: "11201",
      defaultValue: order?.shippingAddress?.zip ?? "",
      autoComplete: "postal-code",
    },
    {
      name: "country",
      label: "Country",
      placeholder: "United States",
      defaultValue: order?.shippingAddress?.country ?? "",
    },
    {
      name: "phone",
      label: "Phone",
      type: "tel",
      placeholder: "+1 555 123 4567",
      defaultValue: order?.shippingAddress?.phone ?? "",
    },
  ];
  // Lights the composer's border beam and the status chip's shimmer.
  const processing = isTicketProcessing(ticketRow.status);
  const resolved = ticketRow.status === "resolved";
  const composerMode =
    singleApproval && singleApprovalDraft !== null
      ? {
          kind: "approval" as const,
          approvalId: singleApproval.id,
          draftBody: singleApprovalDraft,
          proposedInput: singleApproval.proposedInput,
        }
      : pendingApprovals.length > 1 || singleApproval
        ? null // rendered as BundleApprovalBar / ApprovalCard
        : canResume
          ? { kind: "reply" as const }
          : { kind: "locked" as const, message: lockedMessage };

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
  const approvedNotSentItem = approvedNotSentTimelineItem({
    ticketStatus: ticketRow.status,
    approvedNotSent: detail.approvedNotSent,
  });
  const simplifiedTimelineItems: SimplifiedTimelineItem[] = [
    ...entries
      .map((entry) => curatedTimelineEvent(entry, customerEmail))
      .filter((item): item is CuratedTimelineItem => item !== null),
    ...recommendationTimelineItems,
    ...(failedDeliveryItem ? [failedDeliveryItem] : []),
    ...(approvedNotSentItem ? [approvedNotSentItem] : []),
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
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-card py-2.5 pl-4 pr-4 group-data-[sidebar-state=collapsed]/ticket:pl-14">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {customerName}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <Badge
                variant={ticketStatusVariant(ticketRow.status)}
                className="px-1.5 py-0"
              >
                <span className={cn(processing && "chip-shimmer")}>
                  {ticketStatusLabel(ticketRow.status)}
                </span>
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
                {ticketRow.scenarioKey
                  ? humanizeSlug(ticketRow.scenarioKey)
                  : "Uncategorized"}
              </span>
              {customerEmail && customerEmail !== customerName ? (
                // The email is the first thing to give up room on a phone —
                // it's repeated in the details panel.
                <>
                  <span className="hidden sm:inline">·</span>
                  <span className="hidden truncate sm:inline">
                    {customerEmail}
                  </span>
                </>
              ) : null}
              <span>·</span>
              <TicketLiveBoundary ticketId={id} />
            </div>
          </div>

          <TicketHeaderActions
            workspaceId={ctx.workspaceId}
            ticketId={id}
            ticketStatus={ticketRow.status}
            canResolve={canResolve}
            canTakeOver={canTakeOver}
            canResume={canResume}
            showRetrySend={showRetrySend}
            canEscalateFulfillmentOperator={canEscalateFulfillmentOperator}
            canBlockSender={canBlockSender}
            statusTargets={ticketRow.manualStatusTargets ?? []}
            refundSlot={
              order ? (
                <RefundDialog
                  workspaceId={ctx.workspaceId}
                  ticketId={id}
                  orderName={order.name}
                />
              ) : null
            }
          />

          {hasContextCard ? (
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              aria-expanded={contextOpen}
              aria-label={contextOpen ? "Hide context" : "Show context"}
              title={contextOpen ? "Hide context" : "Show context"}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {contextOpen ? (
                <PanelRightClose className="size-4" aria-hidden />
              ) : (
                <PanelRightOpen className="size-4" aria-hidden />
              )}
            </button>
          ) : null}
        </header>

        {/* The chat stage — overflow-hidden parks the context card just past
            the right edge, so opening it reads as sliding out from behind the
            details column. */}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <ChatScrollArea
            // The working indicator and resolved banner render below the last
            // bubble, so their appearance re-pins the scroll too.
            bottomKey={`${threadKey}:${processing ? "w" : ""}:${resolved ? "r" : ""}`}
            className="no-scrollbar min-w-0 flex-1 overflow-y-auto px-4 py-6"
          >
            <div className="mx-auto w-full max-w-3xl">
              <ChatThread
                result={
                  conversationThread ?? {
                    status: "unavailable",
                    reason: "no_thread",
                  }
                }
                workspaceId={ctx.workspaceId}
                ticketId={id}
                processing={processing}
                resolved={resolved}
              />
            </div>
          </ChatScrollArea>

          {/* The card's invisible column: an empty spacer that widens with the
              card (md+ only — on phones the card floats over the chat), pushing
              the centered bubble column left. */}
          <div
            aria-hidden
            className={cn(
              "w-0 shrink-0 transition-[width] duration-300 ease-in-out",
              showContext && "md:w-80",
            )}
          />

          {/* Always mounted: when the last row resolves away (e.g. the quoted
              order ref turns out to match), the card slides out with the same
              transition as the manual toggle instead of unmounting with a pop.
              AnimateHeight keeps the skeleton→content size change smooth. */}
          <aside
            aria-hidden={!showContext}
            aria-label="Ticket context"
            className={cn(
              "thin-scrollbar absolute right-4 top-4 z-10 max-h-[calc(100%-2rem)] w-72 max-w-[85vw] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-md transition-transform duration-300 ease-in-out",
              showContext
                ? "translate-x-0"
                : "pointer-events-none translate-x-[calc(100%+1rem)]",
            )}
          >
            <h2 className="pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context
            </h2>
            <AnimateHeight>
              <TicketContext rows={contextCardRows} />
            </AnimateHeight>
          </aside>
        </div>

        <div className="thin-scrollbar max-h-[60%] shrink-0 overflow-y-auto border-t border-border/60 bg-card px-4 py-3">
          <div className="mx-auto w-full max-w-3xl">
            {composerMode ? (
              <>
                {composerMode.kind === "approval" ? (
                  <ApprovalSignalsStrip
                    approvalId={composerMode.approvalId}
                    recommendation={refundRecommendation}
                    productMatch={productMatch}
                    riskFlags={riskFlags}
                    returnReason={returnReason}
                    requestedResolution={requestedResolution}
                  />
                ) : null}
                <ChatComposer
                  key={composerKey(id, composerMode)}
                  workspaceId={ctx.workspaceId}
                  ticketId={id}
                  customerEmail={customerEmail}
                  models={replyModelsQuery.data ?? null}
                  mode={composerMode}
                  processing={processing}
                />
              </>
            ) : pendingApprovals.length > 1 ? (
              <BundleApprovalBar
                workspaceId={ctx.workspaceId}
                ticketId={id}
                pending={pendingApprovals}
              />
            ) : singleApproval ? (
              <ApprovalCard
                workspaceId={ctx.workspaceId}
                ticketId={id}
                approval={singleApproval}
                refundRecommendation={refundRecommendation}
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

      {/* RIGHT — customer, order, context & timeline */}
      <TicketDetailsPanel>
        <div className="space-y-3 p-3 2xl:space-y-4 2xl:p-4">
          <CustomerPanel
            customer={customer}
            customerEmail={customerEmail}
            verifiedOrderEmail={verifiedOrderEmail}
            headerAction={
              <CardEditPopover
                ticketId={id}
                onSubmit={submitTicketEdit}
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
            actions={
              order ? (
                <>
                  <RefundDialog
                    workspaceId={ctx.workspaceId}
                    ticketId={id}
                    orderName={order.name}
                    size="sm"
                  />
                  <CancelOrderDialog
                    workspaceId={ctx.workspaceId}
                    ticketId={id}
                    orderName={order.name}
                    disabledReason={cancelOrderDisabledReason(order)}
                  />
                  <CardEditPopover
                    ticketId={id}
                    onSubmit={submitShippingAddress}
                    label="Change address"
                    trigger="button"
                    align="right"
                    title="Change shipping address"
                    description="Fix where this order ships. Saves to the order in your store; clear a field to remove it from the address."
                    submitEmpty
                    fields={shippingAddressFields}
                    disabledReason={addressEditDisabledReason(
                      order,
                      shopify?.addressUpdateAfterFulfillment ?? false,
                    )}
                  />
                </>
              ) : undefined
            }
            headerAction={
              <CardEditPopover
                ticketId={id}
                onSubmit={submitTicketEdit}
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

          {/* The agent's refund recommendation is only actionable against a
              real order — without one the button can only fail with
              `order_not_found`, so don't offer it. */}
          {order && refundToIssue && refundToIssue.amount ? (
            <IssueRefundCard
              workspaceId={ctx.workspaceId}
              ticketId={id}
              refund={{ ...refundToIssue, amount: refundToIssue.amount }}
            />
          ) : null}

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Timeline
              </h2>
            </div>

            {/* do not delete: the raw audit timeline is intentionally hidden. */}
            {summaryText || simplifiedTimelineItems.length > 0 ? (
              <div className="space-y-3">
                {summaryText ? (
                  <Card>
                    <CardContent className="space-y-1.5 p-3 2xl:p-4">
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
                          <CardContent className="space-y-1.5 p-3 2xl:p-4">
                            <div className="text-sm font-medium">
                              {item.title}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.responsible} ·{" "}
                              {formatDateTime(item.occurredAt)}
                            </div>
                          </CardContent>
                        ) : item.kind === "note" ? (
                          <CardContent className="space-y-1.5 p-3 2xl:p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                {item.title}
                              </div>
                              <Badge variant="outline">Heads-up to you</Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.delivered === false
                                ? "Not delivered: no notification channel connected"
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
                          <CardContent className="space-y-1.5 p-3 2xl:p-4">
                            <div className="text-sm font-medium">
                              {item.title}
                            </div>
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
                          <CardContent className="space-y-3 p-3 2xl:p-4">
                            <div className="text-sm font-medium">
                              Refund recommendation
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Agent assessment ·{" "}
                              {formatDateTime(item.occurredAt)}
                            </div>
                            <RefundRecommendationBlock
                              recommendation={item.recommendation}
                            />
                          </CardContent>
                        ) : item.kind === "deliveryFailed" ? (
                          <CardContent className="space-y-2 p-3 2xl:p-4">
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
                            <RetrySendButton
                              workspaceId={ctx.workspaceId}
                              ticketId={id}
                            />
                          </CardContent>
                        ) : item.kind === "approvedNotSent" ? (
                          <CardContent className="space-y-2 p-3 2xl:p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                Approved reply not sent
                              </div>
                              <Badge variant="outline">Needs resend</Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {formatDateTime(item.occurredAt)}
                            </div>
                            <p className="break-words text-sm text-muted-foreground">
                              A manager approved this reply, but it was never
                              sent because the ticket was taken over. Send it now
                              if it&apos;s still the right response.
                            </p>
                            {item.bodyPreview ? (
                              <p className="break-words rounded-md bg-muted p-2 text-sm">
                                {item.bodyPreview}
                              </p>
                            ) : null}
                            <ResendApprovalButton
                              workspaceId={ctx.workspaceId}
                              ticketId={id}
                            />
                          </CardContent>
                        ) : (
                          <CardContent className="space-y-3 p-3 2xl:p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">
                                {approvalTimelineLabel(item.approval)}
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
                                <p className="text-sm">
                                  {item.approval.reasoning}
                                </p>
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
