import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import {
  aggregateUsageRows,
  monthBoundsUtc,
  sumUsagePoints,
} from "@/lib/usage";
import { fetchOpenRouterPricing } from "@/lib/openrouter-pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

const formatTokens = (n: number): string => n.toLocaleString();

const formatUsd = (n: number | null): string =>
  n === null
    ? "unpriced"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: n < 0.01 ? 4 : 2,
        maximumFractionDigits: n < 0.01 ? 4 : 2,
      }).format(n);

export function UsagePage() {
  const ctx = useWorkspaceCtx();
  const [month, setMonth] = useState(() => monthBoundsUtc(undefined).month);
  const bounds = monthBoundsUtc(month);
  const startIso = bounds.start.toISOString();
  const endIso = bounds.end.toISOString();

  const rowsQuery = useQuery({
    queryKey: qk.usage(ctx.workspaceId, startIso, endIso),
    queryFn: () => api.usage(ctx, startIso, endIso),
  });

  const pricingQuery = useQuery({
    queryKey: qk.openRouterPricing,
    queryFn: fetchOpenRouterPricing,
    staleTime: 60 * 60 * 1000,
  });

  // The api returns occurredAt as an ISO string; aggregateUsageRows keys by day
  // via Date#toISOString, so hydrate to Date here.
  const rows = (rowsQuery.data ?? []).map((r) => ({
    occurredAt: new Date(r.occurredAt),
    details: r.details,
  }));
  const prices = pricingQuery.data ?? new Map();
  const points = aggregateUsageRows(rows, prices);
  const totals = sumUsagePoints(points);

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Usage" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI usage across this workspace, by day and model. Spend is estimated
          when model pricing is available.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="month">Month</Label>
              <Input
                id="month"
                name="month"
                type="month"
                value={bounds.month}
                onChange={(e) => setMonth(e.currentTarget.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="size-4" aria-hidden />
              Total tokens
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">
              {formatTokens(totals.totalTokens)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatTokens(totals.inputTokens)} input +{" "}
              {formatTokens(totals.outputTokens)} output
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Estimated spend</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">
              {formatUsd(totals.estimatedUsd)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {totals.unpricedRows} unpriced model row
              {totals.unpricedRows === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Models</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-2xl font-semibold tabular-nums">
              {new Set(points.map((p) => p.model)).size}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Distinct model ids this month
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Est. USD</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowsQuery.isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : points.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm italic text-muted-foreground"
                >
                  No AI usage found for this month.
                </TableCell>
              </TableRow>
            ) : (
              points.map((p) => (
                <TableRow key={`${p.day}:${p.provider ?? "unknown"}:${p.model}`}>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {p.day}
                  </TableCell>
                  <TableCell>{p.provider ?? "unknown"}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {p.model}
                    </code>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(p.inputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(p.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(p.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(p.estimatedUsd)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
