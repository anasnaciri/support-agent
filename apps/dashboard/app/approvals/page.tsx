import Link from "next/link";
import { cookies } from "next/headers";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  approvalsHiddenParams,
  isDefaultApprovalsFilter,
  resolveStatusValues,
  toFilterValues,
} from "@/lib/approvals-filters";
import { formatRelativeTime } from "@/lib/format";
import {
  parsePageNumber,
  resolveDefaultPageSize,
  resolvePageSize,
  ROWS_COOKIE,
} from "@/lib/pagination";
import {
  approvalStatusVariant,
  riskVariant,
} from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { TablePagination } from "@/components/TablePagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SearchParams {
  readonly searchParams: Promise<{
    readonly decided?: string;
    readonly action?: string;
    readonly kind?: string;
    readonly status?: string | string[];
    readonly risk?: string | string[];
    readonly tool?: string | string[];
    readonly agent?: string | string[];
    readonly page?: string;
    readonly limit?: string;
  }>;
}

// The status picker offers the three decision states; its "Any status"
// select-all (see MultiSelect.allLabel) checks all three at once. A bare
// (absent) status defaults to pending — the actionable landing view.
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

const bannerFor = (params: {
  decided?: string;
  action?: string;
  kind?: string;
}): {
  readonly tone: "success" | "info" | "warning";
  readonly text: string;
} | null => {
  if (!params.decided) return null;
  const isApprove = params.action === "approve";
  if (params.kind === "decided") {
    return {
      tone: "success",
      text: isApprove
        ? "Approved. The customer reply will be sent in a moment."
        : "Rejected. The case is now in human takeover.",
    };
  }
  if (params.kind === "already_decided") {
    return {
      tone: "info",
      text: "This approval had already been decided — no change.",
    };
  }
  if (params.kind === "approval_not_found") {
    return { tone: "warning", text: "Approval not found." };
  }
  return null;
};

export default async function ApprovalsPage({ searchParams }: SearchParams) {
  const ctx = await getDashboardContext();
  const sp = await searchParams;
  const banner = bannerFor(sp);

  const statusValues = resolveStatusValues(sp.status);
  const riskValues = toFilterValues(sp.risk);
  const toolValues = toFilterValues(sp.tool);
  const agentValues = toFilterValues(sp.agent);
  const filterValues = {
    status: statusValues,
    risk: riskValues,
    tool: toolValues,
    agent: agentValues,
  };
  const cookieRows = (await cookies()).get(ROWS_COOKIE)?.value;
  const defaultPageSize = resolveDefaultPageSize(cookieRows);
  const pageSize = resolvePageSize(sp.limit, cookieRows);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows, statusCounts, toolFacets, agentFacets } =
    await api.approvals(ctx, filterValues, requestedPage, pageSize);

  const countOf = (s: string): number => statusCounts[s] ?? 0;

  const isReset = isDefaultApprovalsFilter(filterValues);

  const paginationParams = approvalsHiddenParams(filterValues);

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Approvals" />

      {banner ? (
        <Alert variant={banner.tone}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Approvals</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="warningBright">{countOf("pending")} pending</Badge>
          <Badge variant="successBright">{countOf("approved")} approved</Badge>
          <Badge variant="destructiveBright">
            {countOf("rejected")} rejected
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <form
            method="get"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            {pageSize !== defaultPageSize ? (
              <input type="hidden" name="limit" value={pageSize} />
            ) : null}
            <div className="space-y-1.5">
              <Label
                htmlFor="status"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Status
              </Label>
              <MultiSelect
                id="status"
                name="status"
                values={statusValues}
                placeholder="Status"
                allLabel="Any status"
                options={STATUS_FILTERS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="risk"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Risk
              </Label>
              <MultiSelect
                id="risk"
                name="risk"
                values={riskValues}
                placeholder="Any risk"
                options={RISK_FILTERS.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="tool"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Tool
              </Label>
              <MultiSelect
                id="tool"
                name="tool"
                values={toolValues}
                placeholder="Any tool"
                options={toolFacets.map((t) => ({ label: t, value: t }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="agent"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Agent
              </Label>
              <MultiSelect
                id="agent"
                name="agent"
                values={agentValues}
                placeholder="Any agent"
                options={agentFacets.map((a) => ({ label: a, value: a }))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit">Apply</Button>
              {!isReset ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/approvals">Reset</Link>
                </Button>
              ) : null}
            </div>
          </form>
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
              <TableHead>Case</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Decided</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
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
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.tool}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={approvalStatusVariant(r.status)}>
                      {r.status}
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
                      href={`/cases/${r.caseId}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.caseId.slice(0, 8)}…
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(r.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.decidedAt ? (
                      formatRelativeTime(r.decidedAt)
                    ) : (
                      <span>—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <TablePagination
        pathname="/approvals"
        page={page}
        pageSize={pageSize}
        totalRows={totalRows}
        defaultPageSize={defaultPageSize}
        hiddenParams={paginationParams}
      />
    </div>
  );
}
