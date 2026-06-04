import { notFound } from "next/navigation";
import Link from "next/link";
import type {
  ApprovalDetail,
  AuditEntry,
} from "@support-agent/dashboard-contracts";

import { api, getDashboardContext } from "@/lib/api-client";
import { caseStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

import CaseLiveBoundary from "./CaseLiveBoundary";
import { CustomerPanel } from "./CustomerPanel";
import { OrderPanel } from "./OrderPanel";
import { ApprovalCard } from "./ApprovalCard";
import { takeOverAction } from "./actions";
import {
  RECOMMENDATION_LABEL,
  extractRefundRecommendation,
  recommendationVariant,
  refundRecommendationFromEntry,
  type RefundRecommendationSummary,
} from "./refund-recommendation";

interface Params {
  readonly params: Promise<{
    readonly id: string;
  }>;
  readonly searchParams: Promise<{
    readonly takenOver?: string;
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
      text: "You've taken over this case. The agent will not act on it further; pending approvals were canceled.",
    };
  }
  if (kind === "already_terminal") {
    return {
      tone: "info",
      text: "This case was already in a terminal state — no change.",
    };
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
        : "Rejected. The case is now in human takeover.",
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

const TERMINAL = new Set(["resolved", "human_takeover", "failed"]);
const INBOUND_EMAIL_EVENTS = new Set(["message.received", "customer.replied"]);
const OUTBOUND_EMAIL_TOOLS = new Set([
  "conversation.reply",
  "conversation.ask_customer",
]);

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

const detailString = (details: unknown, key: string): string | null => {
  const value = detailRecord(details)?.[key];
  return typeof value === "string" ? value : null;
};

const detailBoolean = (details: unknown, key: string): boolean | null => {
  const value = detailRecord(details)?.[key];
  return typeof value === "boolean" ? value : null;
};

/**
 * Defensively parse `context.photoSignals` (stamped by the runtime) into
 * the shape the ApprovalCard expects. Returns null for absent/malformed
 * values so a bad row never crashes the case page.
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
    <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">
      {body}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">No parsed body.</p>
  );
};

const actorLabel = (entry: AuditEntry): string => {
  if (entry.actorType === "customer") return "Customer";
  if (entry.actorType === "agent") return `Agent ${entry.actorId ?? "unknown"}`;
  if (entry.actorType === "user") return `Human ${entry.actorId ?? "unknown"}`;
  return entry.actorId ?? "System";
};

/**
 * Sum input + output tokens across every `llm.decision` audit row on
 * the case. Each row's `details.usage` is populated by `LLMServiceLive`
 * via the Vercel AI SDK; test layers don't populate it (so old or
 * scripted-test cases roll up to zero — which is what we want).
 * Returns null when no usage data is present, so the UI can decide
 * whether to render the rollup at all.
 */
const sumCaseTokens = (
  entries: ReadonlyArray<AuditEntry>,
): { input: number; output: number; total: number } | null => {
  let input = 0;
  let output = 0;
  let saw = false;
  for (const e of entries) {
    if (e.action !== "llm.decision") continue;
    const usage = detailRecord(e.details)?.["usage"];
    const u = detailRecord(usage);
    if (!u) continue;
    saw = true;
    const i = u["inputTokens"];
    const o = u["outputTokens"];
    if (typeof i === "number") input += i;
    if (typeof o === "number") output += o;
  }
  if (!saw) return null;
  return { input, output, total: input + output };
};

type SimplifiedTimelineItem =
  | {
      readonly kind: "email";
      readonly id: string;
      readonly title: string;
      readonly responsible: string;
      readonly occurredAt: string;
    }
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

const simplifiedEmailEvent = (
  entry: AuditEntry,
  customerEmail: string | null,
): SimplifiedTimelineItem | null => {
  if (entry.action === "event.received") {
    const eventType = detailString(entry.details, "eventType");
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
    const tool = detailString(entry.details, "tool");
    if (!tool || !OUTBOUND_EMAIL_TOOLS.has(tool)) return null;
    if (detailBoolean(entry.details, "ok") === false) return null;
    return {
      kind: "email",
      id: `audit-${entry.id}`,
      title: "Email sent",
      responsible: actorLabel(entry),
      occurredAt: entry.occurredAt,
    };
  }

  return null;
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

export default async function CaseDetailPage({ params, searchParams }: Params) {
  const { id } = await params;
  const sp = await searchParams;
  const banner = takeOverBanner(sp.takenOver) ?? approvalBanner(sp);
  const ctx = await getDashboardContext();
  const [detail, shopify] = await Promise.all([
    api.caseDetail(ctx, id),
    api.caseShopify(ctx, id),
  ]);
  if (!detail) notFound();
  const caseRow = detail.case;
  const entries = detail.auditEntries;
  const allApprovals = detail.approvals;
  const customer = shopify?.customer ?? null;
  const order = shopify?.order ?? null;
  const shopDomain = shopify?.shopDomain ?? null;

  const context = (caseRow.context ?? {}) as Readonly<Record<string, unknown>>;
  const customerEmail =
    typeof context["customerEmail"] === "string"
      ? (context["customerEmail"] as string)
      : null;
  const orderHint =
    typeof context["identifiedOrderId"] === "string"
      ? (context["identifiedOrderId"] as string)
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

  const canTakeOver = !TERMINAL.has(caseRow.status);
  const pendingApprovals = allApprovals
    .filter((approval) => approval.status === "pending")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tokenRollup = sumCaseTokens(entries);
  const timelineMode = sp.timeline === "simplified" ? "simplified" : "full";
  const summaryText =
    caseRow.summary ??
    (typeof context["notes"] === "string" ? context["notes"] : null);
  const timelineHref = (mode: "full" | "simplified") => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (value) query.set(key, value);
    }
    if (mode === "simplified") {
      query.set("timeline", "simplified");
    } else {
      query.delete("timeline");
    }
    const search = query.toString();
    return search ? `/cases/${caseRow.id}?${search}` : `/cases/${caseRow.id}`;
  };
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
  const simplifiedTimelineItems: SimplifiedTimelineItem[] = [
    ...entries
      .map((entry) => simplifiedEmailEvent(entry, customerEmail))
      .filter((item): item is SimplifiedTimelineItem => item !== null),
    ...recommendationTimelineItems,
    ...allApprovals.map((approval) => ({
      kind: "approval" as const,
      id: `approval-${approval.id}`,
      approval,
      occurredAt: approval.createdAt,
    })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return (
    <div className="space-y-6">
      {banner ? (
        <Alert variant={toneToVariant(banner.tone)}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {caseRow.subject ?? "(no subject)"}
          </h1>
          <CaseLiveBoundary
            caseId={caseRow.id}
            initialSince={
              entries.length > 0 ? entries[entries.length - 1]!.id : "0"
            }
          />
          {canTakeOver ? (
            <form action={takeOverAction} className="ml-auto">
              <input type="hidden" name="caseId" value={caseRow.id} />
              <Button
                type="submit"
                variant="outline"
                title="Stop the agent on this case and handle it manually"
              >
                Take over
              </Button>
            </form>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={caseStatusVariant(caseRow.status)}>
            {caseRow.status}
          </Badge>
          <span>·</span>
          <span>{caseRow.category ?? "uncategorized"}</span>
          <span>·</span>
          <span>
            agent:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {caseRow.currentAgentId}
            </code>
          </span>
          <span>·</span>
          <span>
            opened {caseRow.createdAt.slice(0, 16).replace("T", " ")}
          </span>
          {tokenRollup ? (
            <>
              <span>·</span>
              <span
                title={`${tokenRollup.input.toLocaleString()} input + ${tokenRollup.output.toLocaleString()} output`}
              >
                tokens:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {tokenRollup.total.toLocaleString()}
                </code>
              </span>
            </>
          ) : null}
        </div>
      </div>

      {pendingApprovals.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          returnTo={`/cases/${caseRow.id}`}
          refundRecommendation={extractRefundRecommendation(entries)}
          productMatch={productMatch}
          photoSignals={photoSignals}
          riskFlags={riskFlags}
        />
      ))}

      <div className="grid gap-4 md:grid-cols-2">
        <CustomerPanel customer={customer} customerEmail={customerEmail} />
        <OrderPanel
          order={order}
          orderHint={orderHint}
          shopDomain={shopDomain}
        />
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Timeline</h2>
          <div className="flex gap-2">
            <Button
              asChild
              size="sm"
              variant={timelineMode === "full" ? "default" : "outline"}
            >
              <Link href={timelineHref("full")}>Full</Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant={timelineMode === "simplified" ? "default" : "outline"}
            >
              <Link href={timelineHref("simplified")}>Simplified</Link>
            </Button>
          </div>
        </div>
        {timelineMode === "simplified" ? (
          summaryText || simplifiedTimelineItems.length > 0 ? (
            <div className="space-y-3">
              {summaryText ? (
                <Card>
                  <CardContent className="space-y-1.5 p-4">
                    <div className="font-medium text-sm">
                      {caseRow.summary ? "Summary" : "Triage notes"}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {summaryText}
                    </p>
                  </CardContent>
                </Card>
              ) : null}

              <ol className="relative space-y-3">
                {simplifiedTimelineItems.map((item) => (
                  <li
                    key={item.id}
                    className="relative ml-2 border-l-2 border-border pl-5"
                  >
                    <span className="absolute -left-[5px] top-3 size-2 rounded-full bg-primary" />
                    <Card>
                      {item.kind === "email" ? (
                        <CardContent className="space-y-1.5 p-4">
                          <div className="font-medium text-sm">
                            {item.title}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {item.responsible} ·{" "}
                            {formatDateTime(item.occurredAt)}
                          </div>
                        </CardContent>
                      ) : item.kind === "refundRecommendation" ? (
                        <CardContent className="space-y-3 p-4">
                          <div className="font-medium text-sm">
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
                      ) : (
                        <CardContent className="space-y-3 p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium text-sm">
                              {approvalStatusLabel(item.approval)}
                            </div>
                            <Badge variant="outline">
                              {item.approval.tool}
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
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">
                              Approved message
                            </div>
                            {item.approval.approvedInput ? (
                              <BodyBlock value={item.approval.approvedInput} />
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                {item.approval.status === "approved"
                                  ? "Not edited; proposed body was approved."
                                  : "No approved body."}
                              </p>
                            )}
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                No sent or received emails, summary, triage notes, or approvals
                recorded for this case yet.
              </CardContent>
            </Card>
          )
        ) : (
          <ol className="relative space-y-3">
            {entries.map((e) => (
              <li
                key={e.id}
                className="relative ml-2 border-l-2 border-border pl-5"
              >
                <span className="absolute -left-[5px] top-3 size-2 rounded-full bg-primary" />
                <Card>
                  {refundRecommendationFromEntry(e) ? (
                    <CardContent className="space-y-3 p-4">
                      <div className="font-medium text-sm">
                        Refund recommendation
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {e.actorType}:{e.actorId} · {formatDateTime(e.occurredAt)}
                      </div>
                      <RefundRecommendationBlock
                        recommendation={refundRecommendationFromEntry(e)!}
                      />
                    </CardContent>
                  ) : (
                    <CardContent className="space-y-1.5 p-4">
                      <div className="font-medium text-sm">{e.action}</div>
                      <div className="text-xs text-muted-foreground">
                        {e.actorType}:{e.actorId} ·{" "}
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
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Context</h2>
        <pre className="overflow-auto rounded-md border bg-card p-3 text-xs">
          {JSON.stringify(caseRow.context, null, 2)}
        </pre>
      </div>
    </div>
  );
}
