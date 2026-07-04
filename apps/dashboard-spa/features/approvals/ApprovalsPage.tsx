import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useTableState } from "@/lib/use-table-state";
import { isDefaultApprovalsFilter } from "@/lib/approvals-filters";
import { formatRelativeTime } from "@/lib/format";
import { approvalStatusLabel, toolActionLabel } from "@/lib/labels";
import { approvalStatusVariant, riskVariant } from "@/lib/status-variants";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { TablePagination } from "@/components/TablePagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// The status picker offers the three decision states; its "Any status"
// select-all checks all three at once. The default (absent) status is pending —
// the actionable landing view.
const STATUS_FILTERS = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
] as const;

const RISK_FILTERS = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
] as const;

const DEFAULT_STATUS = ["pending"];

export function ApprovalsPage() {
  const ctx = useWorkspaceCtx();
  const { page, pageSize, setPage, setPageSize, resetPage } = useTableState();
  const [statusValues, setStatusValues] =
    useState<ReadonlyArray<string>>(DEFAULT_STATUS);
  const [riskValues, setRiskValues] = useState<ReadonlyArray<string>>([]);
  const [toolValues, setToolValues] = useState<ReadonlyArray<string>>([]);
  const [agentValues, setAgentValues] = useState<ReadonlyArray<string>>([]);
  // Remount key so "Reset" clears each MultiSelect's internal selection.
  const [filterKey, setFilterKey] = useState(0);

  const filterValues = {
    status: statusValues,
    risk: riskValues,
    tool: toolValues,
    agent: agentValues,
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.approvals(ctx.workspaceId, filterValues, page, pageSize),
    queryFn: () => api.approvals(ctx, filterValues, page, pageSize),
  });

  const rows = data?.rows ?? [];
  const statusCounts = data?.statusCounts ?? {};
  const toolFacets = data?.toolFacets ?? [];
  const agentFacets = data?.agentFacets ?? [];
  const countOf = (s: string): number => statusCounts[s] ?? 0;
  const isReset = isDefaultApprovalsFilter(filterValues);

  const reset = () => {
    setStatusValues(DEFAULT_STATUS);
    setRiskValues([]);
    setToolValues([]);
    setAgentValues([]);
    setFilterKey((k) => k + 1);
    resetPage();
  };

  const onFilter =
    (setter: (v: ReadonlyArray<string>) => void) =>
    (next: ReadonlyArray<string>) => {
      setter(next);
      resetPage();
    };

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Approvals" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Approvals</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="warning">{countOf("pending")} pending</Badge>
          <Badge variant="successBright">{countOf("approved")} approved</Badge>
          <Badge variant="destructiveBright">
            {countOf("rejected")} rejected
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label
                htmlFor="status"
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Status
              </Label>
              <MultiSelect
                key={`status-${filterKey}`}
                id="status"
                name="status"
                values={statusValues}
                placeholder="Status"
                allLabel="Any status"
                options={STATUS_FILTERS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
                onChange={onFilter(setStatusValues)}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="risk"
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Risk
              </Label>
              <MultiSelect
                key={`risk-${filterKey}`}
                id="risk"
                name="risk"
                values={riskValues}
                placeholder="Any risk"
                options={RISK_FILTERS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
                onChange={onFilter(setRiskValues)}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="tool"
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Tool
              </Label>
              <MultiSelect
                key={`tool-${filterKey}`}
                id="tool"
                name="tool"
                values={toolValues}
                placeholder="Any tool"
                options={toolFacets.map((t) => ({ label: t, value: t }))}
                onChange={onFilter(setToolValues)}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="agent"
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Agent
              </Label>
              <MultiSelect
                key={`agent-${filterKey}`}
                id="agent"
                name="agent"
                values={agentValues}
                placeholder="Any agent"
                options={agentFacets.map((a) => ({ label: a, value: a }))}
                onChange={onFilter(setAgentValues)}
              />
            </div>
            <div className="flex items-end gap-2">
              {!isReset ? (
                <Button variant="ghost" size="sm" onClick={reset}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Ticket</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Decided</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm text-destructive"
                >
                  Couldn’t load approvals.
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm italic text-muted-foreground"
                >
                  No approvals match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/approvals/${r.id}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {toolActionLabel(r.tool)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={approvalStatusVariant(r.status)}>
                      {approvalStatusLabel(r.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={riskVariant(r.riskLevel)}>
                      {r.riskLevel}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.agentId}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/tickets/${r.ticketId}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.ticketId.slice(0, 8)}…
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.decidedAt ? formatRelativeTime(r.decidedAt) : <span>—</span>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <TablePagination
        page={page}
        pageSize={pageSize}
        totalRows={data?.totalRows ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
