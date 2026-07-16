import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  PackageCheck,
  ShieldCheck,
  Sparkles,
  Truck,
  UserRound,
} from "lucide-react";

import type {
  AnalyticsRate,
  DeliveryAnalytics,
  SupportAnalytics,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import {
  analyticsPeriod,
  formatAnalyticsDuration,
  formatAnalyticsLabel,
  formatAnalyticsPercentage,
  formatMinorCurrency,
  formatTransitDays,
} from "@/lib/analytics";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PERIOD_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

const number = new Intl.NumberFormat("en-US");

export function AnalyticsPage() {
  const ctx = useWorkspaceCtx();
  const [trailingDays, setTrailingDays] = useState(30);
  const [periodEnd] = useState(() => new Date());
  const period = useMemo(
    () => analyticsPeriod(periodEnd, trailingDays),
    [periodEnd, trailingDays],
  );

  const supportQuery = useQuery({
    queryKey: qk.supportAnalytics(ctx.workspaceId, period.start, period.end),
    queryFn: () => api.supportAnalytics(ctx, period),
  });
  const deliveryQuery = useQuery({
    queryKey: qk.deliveryAnalytics(ctx.workspaceId, period.start, period.end),
    queryFn: () => api.deliveryAnalytics(ctx, period),
  });

  const loading = supportQuery.isLoading || deliveryQuery.isLoading;
  const failed =
    supportQuery.isError ||
    deliveryQuery.isError ||
    !supportQuery.data ||
    !deliveryQuery.data;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="size-4" aria-hidden />
            Operations intelligence
          </div>
          <h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight">
            Analytics
          </h1>
          <p className="mt-1 max-w-2xl text-pretty text-sm text-muted-foreground">
            See what the agent resolves, where people step in, and how shipments
            move after fulfillment.
          </p>
        </div>
        <label className="min-w-44 space-y-1.5 text-xs font-medium text-muted-foreground">
          Reporting period
          <NativeSelect
            aria-label="Reporting period"
            value={trailingDays}
            onChange={(event) => setTrailingDays(Number(event.currentTarget.value))}
            className="h-10 bg-card text-foreground"
          >
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </header>

      {loading ? (
        <AnalyticsLoading />
      ) : failed ? (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-destructive">
            <AlertTriangle className="size-5 shrink-0" aria-hidden />
            Analytics could not be loaded. Refresh the page to try again.
          </CardContent>
        </Card>
      ) : (
        <AnalyticsContent
          support={supportQuery.data}
          delivery={deliveryQuery.data}
        />
      )}
    </div>
  );
}

function AnalyticsContent({
  support,
  delivery,
}: {
  readonly support: SupportAnalytics;
  readonly delivery: DeliveryAnalytics;
}) {
  return (
    <>
      <p className="-mt-3 text-xs text-muted-foreground">
        {formatPeriod(support.period.start, support.period.end)} · UTC · Rates
        show the underlying count and denominator.
      </p>

      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="sr-only">
          Overview
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <RateCard
            icon={<CheckCircle2 className="size-4 text-success" aria-hidden />}
            label="Ticket resolution"
            rate={support.cohort.resolutionRate}
            noun="tickets"
          />
          <RateCard
            icon={<ShieldCheck className="size-4 text-primary" aria-hidden />}
            label="Draft acceptance"
            rate={support.activity.drafts.accepted}
            noun="decided drafts"
          />
          <RateCard
            icon={<PackageCheck className="size-4 text-success" aria-hidden />}
            label="Shipment delivery"
            rate={delivery.cohort.deliveryRate}
            noun="shipments"
          />
          <MetricCard
            icon={<Truck className="size-4 text-primary" aria-hidden />}
            label="In transit now"
            value={delivery.current.inTransit}
            detail={`${number.format(delivery.current.total)} tracked shipments`}
          />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="support-heading">
        <SectionHeading
          id="support-heading"
          title="Support operations"
          description={`${number.format(support.cohort.ticketsCreated)} tickets entered the cohort; ${number.format(support.activity.ticketsResolved)} resolutions happened during the period.`}
        />

        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <Card>
            <CardHeader>
              <CardTitle>Who handled the resolution</CardTitle>
              <CardDescription>
                Manager-approved agent drafts count as agent-assisted.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <SegmentedBar
                total={support.cohort.ticketsCreated}
                segments={[
                  {
                    label: "Agent-assisted",
                    value: support.cohort.resolutionOwnership.agentAssisted,
                    className: "bg-primary",
                  },
                  {
                    label: "Human-handled",
                    value: support.cohort.resolutionOwnership.humanHandled,
                    className: "bg-warning",
                  },
                  {
                    label: "Unresolved",
                    value: support.cohort.resolutionOwnership.unresolved,
                    className: "bg-muted-foreground/25",
                  },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                <LegendStat
                  icon={<Bot className="size-4 text-primary" aria-hidden />}
                  label="Agent-assisted"
                  value={support.cohort.resolutionOwnership.agentAssisted}
                />
                <LegendStat
                  icon={<UserRound className="size-4 text-warning" aria-hidden />}
                  label="Human-handled"
                  value={support.cohort.resolutionOwnership.humanHandled}
                />
                <LegendStat
                  icon={<Clock3 className="size-4 text-muted-foreground" aria-hidden />}
                  label="Unresolved"
                  value={support.cohort.resolutionOwnership.unresolved}
                />
              </div>

              <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                <RateSummary
                  label="Human handoff"
                  rate={support.cohort.handoffRate}
                  detail={`${number.format(support.cohort.handoffs.merchantTakeovers)} merchant takeovers · ${number.format(support.cohort.handoffs.automaticEscalations)} automatic escalations`}
                />
                <RateSummary
                  label="Still open"
                  rate={{
                    count: support.cohort.resolutionOwnership.unresolved,
                    total: support.cohort.ticketsCreated,
                    percentage:
                      support.cohort.ticketsCreated === 0
                        ? 0
                        : (support.cohort.resolutionOwnership.unresolved /
                            support.cohort.ticketsCreated) *
                          100,
                  }}
                  detail={`${number.format(support.backlog.total)} tickets in the current backlog`}
                />
              </div>
              {support.backlog.byStatus.length > 0 ? (
                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Current backlog
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {support.backlog.byStatus.map((status) => (
                      <span
                        key={status.status}
                        className="rounded-lg bg-muted px-3 py-2 text-xs"
                      >
                        {formatAnalyticsLabel(status.status)}{" "}
                        <strong className="ml-1 font-semibold tabular-nums">
                          {number.format(status.count)}
                        </strong>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Response speed</CardTitle>
              <CardDescription>
                Median elapsed time for activity in this reporting period.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <TimingStat
                label="First response"
                value={formatAnalyticsDuration(
                  support.activity.medianFirstResponseMinutes,
                )}
              />
              <TimingStat
                label="Resolution"
                value={formatAnalyticsDuration(
                  support.activity.medianResolutionMinutes,
                )}
              />
              <TimingStat
                label="Approval wait"
                value={formatAnalyticsDuration(
                  support.activity.medianApprovalWaitMinutes,
                )}
              />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Top ticket categories</CardTitle>
              <CardDescription>
                Sorted by tickets created during the reporting period.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {support.cohort.topScenarios.length === 0 ? (
                <EmptyMetric>No categorized tickets in this period.</EmptyMetric>
              ) : (
                <div className="space-y-4">
                  {support.cohort.topScenarios.map((scenario) => (
                    <RankedBar
                      key={scenario.scenarioKey}
                      label={formatAnalyticsLabel(scenario.scenarioKey)}
                      count={scenario.count}
                      percentage={scenario.percentage}
                    />
                  ))}
                  {support.cohort.unclassifiedTickets > 0 ? (
                    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                      {number.format(support.cohort.unclassifiedTickets)}{" "}
                      unclassified ticket
                      {support.cohort.unclassifiedTickets === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Draft decisions</CardTitle>
              <CardDescription>
                What merchants did with agent drafts after review.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <DraftRow
                label="Accepted unchanged"
                rate={support.activity.drafts.acceptedWithoutEditRate}
                className="bg-success"
              />
              <DraftRow
                label="Edited, then accepted"
                rate={support.activity.drafts.editedThenAcceptedRate}
                className="bg-primary"
              />
              <DraftRow
                label="Declined"
                rate={support.activity.drafts.declinedRate}
                className="bg-destructive"
              />
              <div className="border-t border-border pt-4">
                <RateSummary
                  label="Accepted overall"
                  rate={support.activity.drafts.accepted}
                  detail={`${number.format(support.activity.drafts.accepted.count)} of ${number.format(support.activity.drafts.accepted.total)} decided drafts`}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="delivery-heading">
        <SectionHeading
          id="delivery-heading"
          title="Delivery operations"
          description={`${number.format(delivery.cohort.shipmentsCreated)} shipments entered the cohort; ${number.format(delivery.current.total)} are currently tracked.`}
        />

        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Shipment health</CardTitle>
              <CardDescription>
                Current fleet state, continuously updated from tracking events.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <SegmentedBar
                total={delivery.current.total}
                segments={[
                  {
                    label: "Delivered",
                    value: delivery.current.delivered,
                    className: "bg-success",
                  },
                  {
                    label: "In transit",
                    value: delivery.current.inTransit,
                    className: "bg-primary",
                  },
                  {
                    label: "Pending",
                    value: delivery.current.pending,
                    className: "bg-muted-foreground/35",
                  },
                  {
                    label: "Exceptions",
                    value: delivery.current.exceptions,
                    className: "bg-destructive",
                  },
                  {
                    label: "Stopped",
                    value: delivery.current.stopped,
                    className: "bg-warning",
                  },
                ]}
              />
              <div className="grid grid-cols-2 gap-3">
                <CompactStat
                  label="In transit"
                  value={`${number.format(delivery.current.inTransit)} in transit`}
                />
                <CompactStat
                  label="Pending"
                  value={number.format(delivery.current.pending)}
                />
                <CompactStat
                  label="Exceptions"
                  value={number.format(delivery.current.exceptions)}
                  danger
                />
                <CompactStat
                  label="Tracking stopped"
                  value={number.format(delivery.current.stopped)}
                />
              </div>
              <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                <RateSummary
                  label="Delivery exceptions"
                  rate={delivery.cohort.exceptionRate}
                  detail={`${number.format(delivery.cohort.exceptionRate.count)} shipments hit an exception`}
                />
                <RateSummary
                  label="Exception recovery"
                  rate={delivery.cohort.exceptionRecoveryRate}
                  detail={`${number.format(delivery.cohort.exceptionRecoveryRate.count)} recovered to delivered`}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted/60 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  Median transit time
                </span>
                <span className="font-semibold tabular-nums">
                  {formatTransitDays(delivery.activity.medianTransitDays)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <span>
                  <strong className="font-semibold text-foreground tabular-nums">
                    {number.format(delivery.activity.delivered)}
                  </strong>{" "}
                  delivered during period
                </span>
                <span>
                  <strong className="font-semibold text-foreground tabular-nums">
                    {number.format(delivery.activity.exceptions)}
                  </strong>{" "}
                  exception events
                </span>
                <span>
                  <strong className="font-semibold text-foreground tabular-nums">
                    {number.format(delivery.activity.trackingStopped)}
                  </strong>{" "}
                  tracking stops
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Carrier performance</CardTitle>
              <CardDescription>
                Exception rates for carriers in this shipment cohort.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Carrier</TableHead>
                    <TableHead className="text-right">Shipments</TableHead>
                    <TableHead className="text-right">Exceptions</TableHead>
                    <TableHead className="pr-6 text-right">Exception rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {delivery.cohort.topCarriers.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-sm italic text-muted-foreground"
                      >
                        No carrier activity in this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    delivery.cohort.topCarriers.map((carrier) => (
                      <TableRow key={carrier.carrier}>
                        <TableCell className="pl-6 font-medium">
                          {formatAnalyticsLabel(carrier.carrier)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {number.format(carrier.shipments)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {number.format(carrier.exceptions)}
                        </TableCell>
                        <TableCell className="pr-6 text-right font-medium tabular-nums">
                          {formatAnalyticsPercentage(
                            carrier.exceptionRate.percentage,
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="reliability-heading">
        <SectionHeading
          id="reliability-heading"
          title="Money and reliability"
          description="Refund execution and outbound reply health during the reporting period."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Refunds</CardTitle>
              <CardDescription>
                Successful refunds, split by who executed them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <CompactStat
                  label="Total"
                  value={number.format(support.activity.refunds.total)}
                />
                <CompactStat
                  label="By agent"
                  value={number.format(support.activity.refunds.issuedByAgent)}
                />
                <CompactStat
                  label="By human"
                  value={number.format(support.activity.refunds.issuedByHuman)}
                />
              </div>
              <div className="border-t border-border pt-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Refunded value
                </p>
                {support.activity.refunds.valueByCurrency.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No refunds.</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {support.activity.refunds.valueByCurrency.map((value) => (
                      <span
                        key={value.currencyCode}
                        className="rounded-lg bg-muted px-3 py-2 text-sm font-semibold tabular-nums"
                      >
                        {formatMinorCurrency(
                          value.currencyCode,
                          value.amountMinorUnits,
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reply delivery</CardTitle>
              <CardDescription>
                Customer replies that did not reach a successful provider state.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <CompactStat
                label="Failed deliveries"
                value={number.format(
                  support.activity.customerReplyDeliveries.failed,
                )}
                danger
              />
              <CompactStat
                label="Abandoned retries"
                value={number.format(
                  support.activity.customerReplyDeliveries.abandoned,
                )}
                danger
              />
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  );
}

function SectionHeading({
  id,
  title,
  description,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div>
      <h2 id={id} className="text-balance text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-pretty text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function RateCard({
  icon,
  label,
  rate,
  noun,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly rate: AnalyticsRate;
  readonly noun: string;
}) {
  return (
    <Card className="shadow-[0_0_0_1px_rgba(0,0,0,0.03),0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
          {formatAnalyticsPercentage(rate.percentage)}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="tabular-nums">{number.format(rate.count)}</span> of{" "}
          <span className="tabular-nums">{number.format(rate.total)}</span>{" "}
          {noun}
        </p>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
}) {
  return (
    <Card className="shadow-[0_0_0_1px_rgba(0,0,0,0.03),0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
          {number.format(value)}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function SegmentedBar({
  total,
  segments,
}: {
  readonly total: number;
  readonly segments: ReadonlyArray<{
    readonly label: string;
    readonly value: number;
    readonly className: string;
  }>;
}) {
  return (
    <div
      className="flex h-3 overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={segments
        .map((segment) => `${segment.label}: ${segment.value}`)
        .join(", ")}
    >
      {segments.map((segment) => (
        <span
          key={segment.label}
          className={cn("h-full min-w-0", segment.className)}
          style={{
            width: `${total === 0 ? 0 : (segment.value / total) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

function LegendStat({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="rounded-lg bg-muted/60 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-xl font-semibold tabular-nums">
        {number.format(value)}
      </div>
    </div>
  );
}

function RateSummary({
  label,
  rate,
  detail,
}: {
  readonly label: string;
  readonly rate: AnalyticsRate;
  readonly detail: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-semibold tabular-nums">
          {formatAnalyticsPercentage(rate.percentage)}
        </span>
      </div>
      <p className="mt-1 text-pretty text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function TimingStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 xl:min-h-20">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function RankedBar({
  label,
  count,
  percentage,
}: {
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-4 text-sm">
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {number.format(count)} · {formatAnalyticsPercentage(percentage)}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
        />
      </div>
    </div>
  );
}

function DraftRow({
  label,
  rate,
  className,
}: {
  readonly label: string;
  readonly rate: AnalyticsRate;
  readonly className: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm font-semibold tabular-nums">
          {number.format(rate.count)} ·{" "}
          {formatAnalyticsPercentage(rate.percentage)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", className)}
          style={{
            width: `${Math.min(100, Math.max(0, rate.percentage))}%`,
          }}
        />
      </div>
    </div>
  );
}

function CompactStat({
  label,
  value,
  danger = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly danger?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/60 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          danger && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyMetric({ children }: { readonly children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm italic text-muted-foreground">
      {children}
    </p>
  );
}

function AnalyticsLoading() {
  return (
    <div aria-label="Loading analytics" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-xl bg-muted"
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-80 animate-pulse rounded-xl bg-muted" />
        <div className="h-80 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}

function formatPeriod(start: string, end: string): string {
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${format.format(new Date(start))} – ${format.format(new Date(end))}`;
}
