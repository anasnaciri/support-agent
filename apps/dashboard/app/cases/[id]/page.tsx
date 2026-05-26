import { notFound } from "next/navigation";
import Link from "next/link";
import { asc, and, eq } from "drizzle-orm";
import {
  cases,
  auditLog,
  approvals,
  type AuditLogRow,
  type ApprovalRow,
} from "@support-agent/db";
import { TenantId } from "@support-agent/agent-core";

import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import {
  fetchCustomerForCase,
  fetchOrderForCase,
  fetchShopifyShopDomain,
} from "@/lib/shopify";
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

const formatDateTime = (date: Date): string =>
  date.toISOString().slice(0, 19).replace("T", " ");

const approvalStatusLabel = (approval: ApprovalRow): string => {
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

const actorLabel = (entry: AuditLogRow): string => {
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
export interface RefundRecommendationSummary {
  readonly recommendation: "full_refund" | "partial_refund" | "deny" | "investigate";
  readonly amount: { readonly amount: string; readonly currencyCode: string } | null;
  readonly reasoning: string;
  readonly riskFlags: ReadonlyArray<string>;
}

/**
 * Pull the most recent `refund.recommend` tool.invoked entry from the
 * audit log and return its structured output for rendering on the
 * approval card. Returns null when there's no recommendation row.
 */
const extractRefundRecommendation = (
  entries: ReadonlyArray<AuditLogRow>,
): RefundRecommendationSummary | null => {
  // Walk newest → oldest so re-runs surface the latest recommendation.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.action !== "tool.invoked") continue;
    const details = detailRecord(e.details);
    if (!details || details["tool"] !== "refund.recommend") continue;
    const output = detailRecord(details["output"]);
    if (!output) continue;
    const rec = output["recommendation"];
    if (
      rec !== "full_refund" &&
      rec !== "partial_refund" &&
      rec !== "deny" &&
      rec !== "investigate"
    ) {
      continue;
    }
    const reasoning =
      typeof output["reasoning"] === "string"
        ? (output["reasoning"] as string)
        : "";
    const flagsRaw = output["riskFlags"];
    const riskFlags = Array.isArray(flagsRaw)
      ? flagsRaw.filter((f): f is string => typeof f === "string")
      : [];
    const amountRaw = detailRecord(output["amount"]);
    const amount =
      amountRaw &&
      typeof amountRaw["amount"] === "string" &&
      typeof amountRaw["currencyCode"] === "string"
        ? {
            amount: amountRaw["amount"] as string,
            currencyCode: amountRaw["currencyCode"] as string,
          }
        : null;
    return { recommendation: rec, amount, reasoning, riskFlags };
  }
  return null;
};

const sumCaseTokens = (
  entries: ReadonlyArray<AuditLogRow>,
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
      readonly occurredAt: Date;
    }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly approval: ApprovalRow;
      readonly occurredAt: Date;
    };

const simplifiedEmailEvent = (
  entry: AuditLogRow,
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

export default async function CaseDetailPage({ params, searchParams }: Params) {
  const { id } = await params;
  const sp = await searchParams;
  const banner = takeOverBanner(sp.takenOver) ?? approvalBanner(sp);
  const d = db();
  const tenantId = await getTenantId();
  const [caseRow] = await d
    .select()
    .from(cases)
    .where(and(eq(cases.id, id), eq(cases.tenantId, tenantId)))
    .limit(1);
  if (!caseRow) notFound();

  const context = (caseRow.context ?? {}) as Readonly<Record<string, unknown>>;
  const customerEmail =
    typeof context["customerEmail"] === "string"
      ? (context["customerEmail"] as string)
      : null;
  const orderHint =
    typeof context["identifiedOrderId"] === "string"
      ? (context["identifiedOrderId"] as string)
      : null;

  const [entries, customer, order, allApprovals, shopDomain] =
    await Promise.all([
      d
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.caseId, id), eq(auditLog.tenantId, tenantId)))
        .orderBy(asc(auditLog.id)),
      fetchCustomerForCase(TenantId(tenantId), context),
      fetchOrderForCase(TenantId(tenantId), context),
      d
        .select()
        .from(approvals)
        .where(and(eq(approvals.caseId, id), eq(approvals.tenantId, tenantId)))
        .orderBy(asc(approvals.createdAt)),
      fetchShopifyShopDomain(TenantId(tenantId)),
    ]);

  const canTakeOver = !TERMINAL.has(caseRow.status);
  const pendingApprovals = allApprovals
    .filter((approval) => approval.status === "pending")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
  const simplifiedTimelineItems = [
    ...entries
      .map((entry) => simplifiedEmailEvent(entry, customerEmail))
      .filter((item): item is SimplifiedTimelineItem => item !== null),
    ...allApprovals.map((approval) => ({
      kind: "approval" as const,
      id: `approval-${approval.id}`,
      approval,
      occurredAt: approval.createdAt,
    })),
  ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

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
          <CaseLiveBoundary caseId={caseRow.id} />
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
            opened{" "}
            {caseRow.createdAt.toISOString().slice(0, 16).replace("T", " ")}
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
                  <CardContent className="space-y-1.5 p-4">
                    <div className="font-medium text-sm">{e.action}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.actorType}:{e.actorId} · {formatDateTime(e.occurredAt)}
                    </div>
                    {e.details ? (
                      <pre className="overflow-auto rounded-md bg-muted/50 p-2 text-xs">
                        {JSON.stringify(e.details, null, 2)}
                      </pre>
                    ) : null}
                  </CardContent>
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
