import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ApprovalDetail } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { usePathname } from "@/lib/navigation";
import { caseIdFromPathname } from "@/lib/cases-sidebar-data";
import { cn } from "@/lib/utils";
import {
  auditActionLabel,
  caseStatusLabel,
  humanizeSlug,
  toolActionLabel,
} from "@/lib/labels";
import { caseStatusVariant } from "@/lib/status-variants";
import {
  curatedTimelineEvent,
  replyDeliveryFailedTimelineItem,
  type CuratedTimelineItem,
} from "@/lib/case-timeline";
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
import { buildContextRows } from "@/lib/case-context";
import { parseLiveTracking } from "@/lib/tracking-panel-data";
import { shouldShowRetrySendAction } from "@/lib/retry-send-visibility";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChatThread } from "./ChatThread";
import { ChatScrollArea } from "./ChatScrollArea";
import { CaseDetailsPanel } from "./CaseDetailsPanel";
import { CaseHeaderActions } from "./CaseHeaderActions";
import { ChatComposer } from "./ChatComposer";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalSignalsStrip } from "./ApprovalSignalsStrip";
import { BundleApprovalBar } from "./BundleApprovalBar";
import { IssueRefundCard } from "./IssueRefundCard";
import { RefundDialog } from "./RefundDialog";
import { RetrySendButton } from "./RetrySendButton";
import { CustomerPanel } from "./CustomerPanel";
import { OrderPanel } from "./OrderPanel";
import { TrackingPanel } from "./TrackingPanel";
import { CaseDetailLoading } from "./CaseDetailLoading";

// ⚠️ Phase 3 = READ-ONLY. This is the SPA port of the Next case-detail page's
// display: the conversation thread, the customer/order/tracking panels, the
// case context, and the activity/audit timeline. The interactive surface —
// composer, approve/reject, take-over/resume/resolve, refund dialog, the ⋮
// actions menu, and the live-refresh boundary — lands in Phase 4/5. The read-
// only derivations + timeline assembly mirror the Next page 1:1.

// UI-visibility gates for the header actions (NOT the §10 transition matrix —
// the api enforces the real rules; these just decide which buttons to show).
const TERMINAL = new Set(["resolved", "human_takeover", "failed"]);
const RESOLVE_HIDDEN = new Set([
  "resolved",
  "failed",
  "waiting_for_approval",
  "waiting_for_supplier",
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
            className="font-mono text-[10px] uppercase tracking-wider"
          >
            {flag}
          </Badge>
        ))}
      </div>
    ) : null}
  </div>
);

function CaseContext({
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

export function CaseDetailPage() {
  const ctx = useWorkspaceCtx();
  const pathname = usePathname() ?? "";
  const id = caseIdFromPathname(pathname) ?? "";
  const [showFullAudit, setShowFullAudit] = useState(false);

  const detailQuery = useQuery({
    queryKey: qk.case(ctx.workspaceId, id),
    queryFn: () => api.caseDetail(ctx, id),
    enabled: id.length > 0,
  });
  const shopifyQuery = useQuery({
    queryKey: qk.caseShopify(ctx.workspaceId, id),
    queryFn: () => api.caseShopify(ctx, id),
    enabled: id.length > 0,
  });
  const threadQuery = useQuery({
    queryKey: qk.caseThread(ctx.workspaceId, id),
    queryFn: () => api.caseConversationThread(ctx, id),
    enabled: id.length > 0,
  });
  const trackingQuery = useQuery({
    queryKey: qk.caseTracking(ctx.workspaceId, id),
    queryFn: () => api.caseTracking(ctx, id),
    enabled: id.length > 0,
  });
  // The rephrase model picker's catalog — tolerant (null when the member can't
  // read it), so a reply-only member still gets the composer minus the picker.
  const replyModelsQuery = useQuery({
    queryKey: qk.models(ctx.workspaceId),
    queryFn: () => api.replyModels(ctx),
    enabled: id.length > 0,
  });

  if (detailQuery.isLoading) return <CaseDetailLoading />;

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-sm font-medium">Case not found</p>
          <p className="text-sm text-muted-foreground">
            It may have been deleted, or belong to another workspace.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/cases">Back to cases</Link>
          </Button>
        </div>
      </div>
    );
  }

  const caseRow = detail.case;
  const entries = detail.auditEntries;
  const allApprovals = detail.approvals;
  const shopify = shopifyQuery.data ?? null;
  const customer = shopify?.customer ?? null;
  const order = shopify?.order ?? null;
  const shopDomain = shopify?.shopDomain ?? null;
  const conversationThread = threadQuery.data ?? null;
  const trackingResult = trackingQuery.data ?? null;

  const context = (caseRow.context ?? {}) as Readonly<Record<string, unknown>>;
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

  // Prefer the fresh live lookup (rich: origin/destination, transit days, full
  // checkpoint history); fall back to the on-case `liveTrackingStatus` stamp.
  const liveTracking =
    trackingResult?.kind === "ok"
      ? parseLiveTracking(trackingResult.tracking)
      : null;
  const tracking =
    liveTracking ?? parseLiveTracking(context["liveTrackingStatus"]);

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

  const pendingApprovals = allApprovals
    .filter((a) => a.status === "pending")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const canTakeOver = !TERMINAL.has(caseRow.status);
  const canResume = caseRow.status === "human_takeover";
  const canResolve = !RESOLVE_HIDDEN.has(caseRow.status);
  const showRetrySend = shouldShowRetrySendAction({
    caseStatus: caseRow.status,
    activeReplyDelivery: detail.activeReplyDelivery,
    riskFlags,
  });
  const summaryText =
    caseRow.summary ??
    (typeof context["notes"] === "string" ? context["notes"] : null);

  // Why the composer is read-only when the agent owns the conversation.
  const lockedMessage =
    caseRow.status === "resolved"
      ? "This case is resolved. Reopen it from the status menu to reply."
      : caseRow.status === "failed"
        ? "This case is closed. Reopen it from the status menu to reply."
        : caseRow.status === "waiting_for_supplier"
          ? "Waiting on the supplier. Take over to reply to the customer."
          : "The agent is handling this conversation. Take over to reply yourself.";

  // Composer routing: a single reply draft awaiting approval fills the input
  // with Approve/Reject; a bundle or a non-reply approval keeps its richer card;
  // a taken-over case lets the manager reply by hand; else it's locked.
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
  const refundableOrder =
    order && order.financialStatus !== "refunded" ? order : null;
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
    caseStatus: caseRow.status,
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
        <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card py-2.5 pl-4 pr-4 group-data-[sidebar-state=collapsed]/case:pl-14">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {customerName}
              </h1>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant={caseStatusVariant(caseRow.status)}
                className="px-1.5 py-0"
              >
                {caseStatusLabel(caseRow.status)}
              </Badge>
              <span>·</span>
              <span>
                {caseRow.category
                  ? humanizeSlug(caseRow.category)
                  : "Uncategorized"}
              </span>
              {customerEmail && customerEmail !== customerName ? (
                <>
                  <span>·</span>
                  <span className="truncate">{customerEmail}</span>
                </>
              ) : null}
            </div>
          </div>

          <CaseHeaderActions
            workspaceId={ctx.workspaceId}
            caseId={id}
            canResolve={canResolve}
            canTakeOver={canTakeOver}
            canResume={canResume}
            showRetrySend={showRetrySend}
            statusTargets={caseRow.manualStatusTargets ?? []}
            refundSlot={
              refundableOrder ? (
                <RefundDialog
                  compact
                  workspaceId={ctx.workspaceId}
                  caseId={id}
                  orderName={refundableOrder.name}
                />
              ) : null
            }
          />
        </header>

        <ChatScrollArea
          bottomKey={threadKey}
          className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-6"
        >
          <div className="mx-auto w-full max-w-3xl">
            <ChatThread
              result={
                conversationThread ?? {
                  status: "unavailable",
                  reason: "no_thread",
                }
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
                    recommendation={refundRecommendation}
                    productMatch={productMatch}
                    riskFlags={riskFlags}
                    returnReason={returnReason}
                    requestedResolution={requestedResolution}
                  />
                ) : null}
                <ChatComposer
                  key={id}
                  workspaceId={ctx.workspaceId}
                  caseId={id}
                  customerEmail={customerEmail}
                  models={replyModelsQuery.data ?? null}
                  mode={composerMode}
                />
              </>
            ) : pendingApprovals.length > 1 ? (
              <BundleApprovalBar
                workspaceId={ctx.workspaceId}
                caseId={id}
                pending={pendingApprovals}
              />
            ) : singleApproval ? (
              <ApprovalCard
                workspaceId={ctx.workspaceId}
                caseId={id}
                approval={singleApproval}
                refundRecommendation={refundRecommendation}
                productMatch={productMatch}
                photoSignals={photoSignals}
                riskFlags={riskFlags}
                returnReason={returnReason}
                requestedResolution={requestedResolution}
              />
            ) : null}
          </div>
        </div>
      </section>

      {/* RIGHT — customer, order, context & timeline */}
      <CaseDetailsPanel>
        <div className="space-y-4 p-4">
          <CustomerPanel
            customer={customer}
            customerEmail={customerEmail}
            verifiedOrderEmail={verifiedOrderEmail}
          />
          <OrderPanel order={order} orderHint={orderHint} shopDomain={shopDomain} />
          {tracking ? (
            <TrackingPanel
              tracking={tracking}
              destinationCountry={order?.shippingAddress?.country ?? null}
              orderPlacedAt={order?.createdAt ?? null}
            />
          ) : null}

          {refundToIssue && refundToIssue.amount ? (
            <IssueRefundCard
              workspaceId={ctx.workspaceId}
              caseId={id}
              refund={{ ...refundToIssue, amount: refundToIssue.amount }}
            />
          ) : null}

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context
            </h2>
            <CaseContext context={context} />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Timeline
              </h2>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={!showFullAudit ? "default" : "outline"}
                  onClick={() => setShowFullAudit(false)}
                >
                  Activity
                </Button>
                <Button
                  size="sm"
                  variant={showFullAudit ? "default" : "outline"}
                  onClick={() => setShowFullAudit(true)}
                >
                  Audit
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
                        {caseRow.summary ? "Summary" : "Triage notes"}
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
                            <div className="text-sm font-medium">
                              {item.title}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.responsible} ·{" "}
                              {formatDateTime(item.occurredAt)}
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
                          <CardContent className="space-y-3 p-4">
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
                            <RetrySendButton
                              workspaceId={ctx.workspaceId}
                              caseId={id}
                            />
                          </CardContent>
                        ) : (
                          <CardContent className="space-y-3 p-4">
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
      </CaseDetailsPanel>
    </div>
  );
}
