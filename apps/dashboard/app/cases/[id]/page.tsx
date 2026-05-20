import { notFound } from "next/navigation";
import { asc, desc, and, eq } from "drizzle-orm";
import { cases, auditLog, approvals } from "@support-agent/db";
import { TenantId } from "@support-agent/agent-core";

import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { fetchCustomerForCase, fetchOrderForCase } from "@/lib/shopify";
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

const toneToVariant = (tone: Banner["tone"]) =>
  tone === "success" ? "success" : tone === "info" ? "info" : "warning";

export default async function CaseDetailPage({
  params,
  searchParams,
}: Params) {
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

  const [entries, customer, order, pendingApprovals] = await Promise.all([
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
      .where(
        and(
          eq(approvals.caseId, id),
          eq(approvals.tenantId, tenantId),
          eq(approvals.status, "pending"),
        ),
      )
      .orderBy(desc(approvals.createdAt)),
  ]);

  const canTakeOver = !TERMINAL.has(caseRow.status);

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
        </div>
      </div>

      {pendingApprovals.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          returnTo={`/cases/${caseRow.id}`}
        />
      ))}

      <div className="grid gap-4 md:grid-cols-2">
        <CustomerPanel customer={customer} customerEmail={customerEmail} />
        <OrderPanel order={order} orderHint={orderHint} />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Timeline</h2>
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
                    {e.actorType}:{e.actorId} ·{" "}
                    {e.occurredAt.toISOString().slice(0, 19).replace("T", " ")}
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
