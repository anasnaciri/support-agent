import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  HelpCircle,
} from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { caseSubjectLabel, hasSubject, toolActionLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { resolveFeedback } from "@/lib/toast-feedback";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";

const TOP_N = 5;

interface TodaySearchParams {
  readonly searchParams?: Promise<{
    readonly onboarded?: string;
    readonly workspace_created?: string;
    readonly workspace_deleted?: string;
  }>;
}

export default async function TodayPage({ searchParams }: TodaySearchParams) {
  const sp = searchParams ? await searchParams : {};
  const ctx = await getDashboardContext();
  // A supplier (constrained external role) has no merchant surface — send them
  // to their portal instead of a "Today" page whose data they can't read.
  if (
    ctx.permissions.has("supplier.cases.view") &&
    !ctx.permissions.has("cases.view")
  ) {
    redirect("/supplier/cases");
  }
  const summary = await api.today(ctx);

  const feedback = resolveFeedback(sp, [
    {
      param: "onboarded",
      kind: "success",
      message: "Your workspace is ready",
      description:
        "Connect Shopify or Gmail from Settings → Integrations to start receiving cases.",
      action: { label: "Open Integrations", href: "/settings/integrations" },
    },
    {
      param: "workspace_created",
      kind: "success",
      message: `Workspace created — you're now in ${ctx.tenantName}`,
      description:
        "Connect this workspace's store and mailbox from Settings → Integrations to start receiving cases.",
      action: { label: "Open Integrations", href: "/settings/integrations" },
    },
    {
      param: "workspace_deleted",
      kind: "success",
      message: "Workspace deleted",
      description: `You're back in ${ctx.tenantName}. The deleted workspace's data and connections are being cleaned up.`,
    },
  ]);

  const { pendingApprovals, takeoverCases } = summary;
  const countOf = (status: string): number =>
    summary.statusCounts[status] ?? 0;

  const pendingCount = pendingApprovals.length;
  const takeoverCount = takeoverCases.length;
  const inProgress =
    countOf("new") + countOf("in_progress") + countOf("triaging");
  const waitingCustomer = countOf("waiting_for_customer");
  const waitingSupplier = countOf("waiting_for_supplier");
  const waitingApproval = countOf("waiting_for_approval");
  const resolvedTodayCount = summary.resolvedTodayCount;

  return (
    <div className="space-y-6">
      <FeedbackToaster toasts={feedback.toasts} consume={feedback.consume} />

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

      <Card>
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
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {toolActionLabel(a.tool)}
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

      <Card>
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
                      className={cn(
                        "text-sm font-medium hover:underline",
                        !hasSubject(c.subject) &&
                          "font-normal italic text-muted-foreground",
                      )}
                    >
                      {caseSubjectLabel(c.subject)}
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
        <StatTile
          label="In progress"
          value={inProgress}
          hint="Cases the agent is actively handling right now (new, triaging, in progress) — not cases parked waiting for approval, a customer, or a supplier to be resolved."
        />
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
  hint,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon?: React.ReactNode;
  readonly hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
          {hint ? <InfoHint text={hint} /> : null}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

// A branded "?" help affordance for a metric: hovering or focusing the icon
// reveals a themed bubble. CSS-only (Tailwind group utilities) so it works in
// this server component without a client island — and accessible via the icon's
// aria-label.
function InfoHint({ text }: { readonly text: string }) {
  return (
    <span className="group/hint relative inline-flex">
      <HelpCircle
        role="img"
        aria-label={text}
        tabIndex={0}
        className="size-3.5 cursor-help text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/hint:opacity-100 group-focus-within/hint:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
