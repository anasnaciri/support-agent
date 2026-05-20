import Link from "next/link";
import { sql, eq, and, gte, desc } from "drizzle-orm";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Sprout,
} from "lucide-react";
import { approvals, cases } from "@support-agent/db";

import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { formatRelativeTime } from "@/lib/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const TOP_N = 5;

interface TodaySearchParams {
  readonly searchParams?: Promise<{ readonly onboarded?: string }>;
}

export default async function TodayPage({ searchParams }: TodaySearchParams) {
  const sp = searchParams ? await searchParams : {};
  const justOnboarded = sp.onboarded === "1";
  const d = db();
  const tenantId = await getTenantId();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [byStatus, pendingApprovals, takeoverCases, resolvedToday] =
    await Promise.all([
      d
        .select({
          status: cases.status,
          count: sql<number>`count(*)::int`,
        })
        .from(cases)
        .where(eq(cases.tenantId, tenantId))
        .groupBy(cases.status),
      d
        .select({
          id: approvals.id,
          caseId: approvals.caseId,
          tool: approvals.tool,
          agentId: approvals.agentId,
          riskLevel: approvals.riskLevel,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.tenantId, tenantId),
            eq(approvals.status, "pending"),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(TOP_N),
      d
        .select({
          id: cases.id,
          subject: cases.subject,
          category: cases.category,
          updatedAt: cases.updatedAt,
        })
        .from(cases)
        .where(
          and(
            eq(cases.tenantId, tenantId),
            eq(cases.status, "human_takeover"),
          ),
        )
        .orderBy(desc(cases.updatedAt))
        .limit(TOP_N),
      d
        .select({ count: sql<number>`count(*)::int` })
        .from(cases)
        .where(
          and(
            eq(cases.tenantId, tenantId),
            eq(cases.status, "resolved"),
            gte(cases.resolvedAt, todayStart),
          ),
        ),
    ]);

  const countOf = (status: string): number =>
    byStatus.find((r) => r.status === status)?.count ?? 0;

  const pendingCount = pendingApprovals.length;
  const takeoverCount = takeoverCases.length;
  const inProgress =
    countOf("new") + countOf("in_progress") + countOf("triaging");
  const waitingCustomer = countOf("waiting_for_customer");
  const waitingSupplier = countOf("waiting_for_supplier");
  const waitingApproval = countOf("waiting_for_approval");
  const resolvedTodayCount = resolvedToday[0]?.count ?? 0;

  return (
    <div className="space-y-6">
      {justOnboarded ? (
        <Alert variant="success">
          <Sprout className="size-4" />
          <AlertTitle>Tenant created</AlertTitle>
          <AlertDescription>
            Connect Shopify or Gmail from{" "}
            <Link
              href="/settings/integrations"
              className="font-medium underline underline-offset-2"
            >
              Settings → Integrations
            </Link>{" "}
            to start receiving cases.
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          AI handled{" "}
          <span className="font-semibold text-foreground">
            {resolvedTodayCount}
          </span>{" "}
          ticket{resolvedTodayCount === 1 ? "" : "s"} today ·{" "}
          <span className="font-semibold text-foreground">{inProgress}</span> in
          progress ·{" "}
          <span className="font-semibold text-foreground">
            {waitingApproval}
          </span>{" "}
          waiting for approval ·{" "}
          <span className="font-semibold text-foreground">{takeoverCount}</span>{" "}
          need human takeover
        </p>
      </div>

      <Card className="border-warning/40">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="size-4 text-warning" />
            <CardTitle>Need your approval</CardTitle>
          </div>
          <Badge variant="warning">{waitingApproval}</Badge>
        </CardHeader>
        <CardContent className="pt-0">
          {pendingApprovals.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              Nothing pending. The agent's drafts will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {pendingApprovals.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/approvals/${a.id}`}
                      className="font-mono text-sm text-primary hover:underline"
                    >
                      {a.tool}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {a.agentId} ·{" "}
                      <Link
                        href={`/cases/${a.caseId}`}
                        className="hover:underline"
                      >
                        case {a.caseId.slice(0, 8)}…
                      </Link>
                    </div>
                  </div>
                  <div className="ml-4 shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(a.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pendingCount > 0 ? (
            <div className="mt-4 flex justify-end border-t border-border pt-3">
              <Link
                href="/approvals"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                View all {waitingApproval}
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            <CardTitle>Need human takeover</CardTitle>
          </div>
          <Badge variant="destructive">{takeoverCount}</Badge>
        </CardHeader>
        <CardContent className="pt-0">
          {takeoverCases.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              Nothing escalated. Cases that need a human will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {takeoverCases.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/cases/${c.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {c.subject ?? "(no subject)"}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {c.category ?? "uncategorized"}
                    </div>
                  </div>
                  <div className="ml-4 shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(c.updatedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {takeoverCount >= TOP_N ? (
            <div className="mt-4 flex justify-end border-t border-border pt-3">
              <Link
                href="/cases"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                View all cases
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Waiting for customer" value={waitingCustomer} />
        <StatTile label="Waiting for supplier" value={waitingSupplier} />
        <StatTile label="In progress" value={inProgress} />
        <StatTile
          label="Resolved (all-time)"
          value={countOf("resolved")}
          icon={<CheckCircle2 className="size-3.5 text-primary" />}
        />
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
