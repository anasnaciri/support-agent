import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  HelpCircle,
} from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { useAppNavigate } from "@/lib/navigation";
import { formatRelativeTime } from "@/lib/format";
import { ticketSubjectLabel, hasSubject, toolActionLabel } from "@/lib/labels";
import { resolveFeedback, type FeedbackRule } from "@/lib/toast-feedback";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";

const TOP_N = 5;

export function HomePage() {
  const session = useSession();
  const ctx = useWorkspaceCtx();
  const nav = useAppNavigate();

  // When the ACTIVE workspace is a fulfillment partner one, the member has no merchant
  // surface for it — send them to the portal instead of a "Today" page whose
  // data they can't read. Permissions follow the active workspace's kind, so a
  // dual-role user only lands here while a merchant workspace is active.
  const activeIsFulfillmentOperator =
    session.permissions.has("fulfillment_operator.tickets.view") &&
    !session.permissions.has("tickets.view");
  useEffect(() => {
    if (activeIsFulfillmentOperator) nav.replace("/fulfillment-operator/tickets");
  }, [activeIsFulfillmentOperator, nav]);

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.today(ctx.workspaceId),
    queryFn: () => api.today(ctx),
    enabled: !activeIsFulfillmentOperator,
  });

  // Post-onboarding / workspace lifecycle toasts, read once from the URL.
  const tenantName = session.activeWorkspace.name;
  const feedback = useMemo(() => {
    const rules: FeedbackRule[] = [
      {
        param: "onboarded",
        kind: "success",
        message: "Your workspace is ready",
        description:
          "Connect Shopify or Gmail from Settings → Integrations to start receiving tickets.",
        action: { label: "Open Integrations", href: "/settings/integrations" },
      },
      {
        param: "workspace_created",
        kind: "success",
        message: `Workspace created. You're now in ${tenantName}`,
        description:
          "Connect this workspace's store and mailbox from Settings → Integrations to start receiving tickets.",
        action: { label: "Open Integrations", href: "/settings/integrations" },
      },
      {
        param: "workspace_deleted",
        kind: "success",
        message: "Workspace deleted",
        description: `You're back in ${tenantName}. The deleted workspace's data and connections are being cleaned up.`,
      },
    ];
    return resolveFeedback(new URLSearchParams(window.location.search), rules);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (activeIsFulfillmentOperator) return null; // redirecting to the fulfillment partner portal
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError || !data) {
    return (
      <p className="text-sm text-destructive">Couldn’t load your summary.</p>
    );
  }

  const { pendingApprovals, takeoverTickets } = data;
  const countOf = (status: string): number => data.statusCounts[status] ?? 0;

  const pendingCount = pendingApprovals.length;
  const takeoverCount = takeoverTickets.length;
  const inProgress =
    countOf("new") + countOf("in_progress") + countOf("triaging");
  const waitingCustomer = countOf("waiting_for_customer");
  const waitingFulfillmentOperator = countOf("waiting_for_fulfillment_operator");
  const waitingApproval = countOf("waiting_for_approval");
  const resolvedTodayCount = data.resolvedTodayCount;

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
                        href={`/tickets/${a.ticketId}`}
                        className="hover:underline"
                      >
                        ticket {a.ticketId.slice(0, 8)}…
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
          {takeoverTickets.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              Nothing escalated. Tickets that need a human will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {takeoverTickets.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/tickets/${c.id}`}
                      className={cn(
                        "text-sm font-medium hover:underline",
                        !hasSubject(c.subject) &&
                          "font-normal italic text-muted-foreground",
                      )}
                    >
                      {ticketSubjectLabel(c.subject)}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {c.scenarioKey ?? "uncategorized"}
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
                href="/tickets"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                View all tickets
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Waiting for customer" value={waitingCustomer} />
        <StatTile label="Waiting for fulfillment partner" value={waitingFulfillmentOperator} />
        <StatTile
          label="In progress"
          value={inProgress}
          hint="Tickets the agent is actively handling right now (new, triaging, in progress), not tickets parked waiting for approval, a customer, or a fulfillment partner to be resolved."
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
// reveals a themed bubble. CSS-only (Tailwind group utilities) so it needs no
// client state — accessible via the icon's aria-label.
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
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[0.6875rem] font-normal normal-case leading-snug tracking-normal text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/hint:opacity-100 group-focus-within/hint:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
