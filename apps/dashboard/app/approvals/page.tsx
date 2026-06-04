import Link from "next/link";

import { api, getDashboardContext } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import {
  DEFAULT_PAGE_SIZE,
  parsePageNumber,
  parsePageSize,
} from "@/lib/pagination";
import {
  approvalStatusVariant,
  riskVariant,
} from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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
    readonly status?: string;
    readonly risk?: string;
    readonly tool?: string;
    readonly agent?: string;
    readonly page?: string;
    readonly limit?: string;
  }>;
}

const STATUS_FILTERS = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
  { label: "Any status", value: "any" },
] as const;

const RISK_FILTERS = [
  { label: "Any risk", value: "" },
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

  const statusFilter = sp.status ?? "pending";
  const riskFilter = sp.risk ?? "";
  const toolFilter = sp.tool ?? "";
  const agentFilter = sp.agent ?? "";
  const pageSize = parsePageSize(sp.limit);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows, statusCounts, toolFacets, agentFacets } =
    await api.approvals(
      ctx,
      {
        status: statusFilter,
        ...(riskFilter ? { risk: riskFilter } : {}),
        ...(toolFilter ? { tool: toolFilter } : {}),
        ...(agentFilter ? { agent: agentFilter } : {}),
      },
      requestedPage,
      pageSize,
    );

  const countOf = (s: string): number => statusCounts[s] ?? 0;

  const isReset =
    !riskFilter &&
    !toolFilter &&
    !agentFilter &&
    statusFilter === "pending";

  const paginationParams: ReadonlyArray<readonly [string, string]> = [
    ["status", statusFilter !== "pending" ? statusFilter : ""],
    ["risk", riskFilter],
    ["tool", toolFilter],
    ["agent", agentFilter],
  ];

  return (
    <div className="space-y-6">
      {banner ? (
        <Alert variant={banner.tone}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Approvals</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="warning">{countOf("pending")} pending</Badge>
          <Badge variant="success">{countOf("approved")} approved</Badge>
          <Badge variant="destructive">{countOf("rejected")} rejected</Badge>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <form
            method="get"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            {pageSize !== DEFAULT_PAGE_SIZE ? (
              <input type="hidden" name="limit" value={pageSize} />
            ) : null}
            <div className="space-y-1.5">
              <Label
                htmlFor="status"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Status
              </Label>
              <NativeSelect
                id="status"
                name="status"
                defaultValue={statusFilter}
              >
                {STATUS_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="risk"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Risk
              </Label>
              <NativeSelect id="risk" name="risk" defaultValue={riskFilter}>
                {RISK_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="tool"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Tool
              </Label>
              <NativeSelect id="tool" name="tool" defaultValue={toolFilter}>
                <option value="">Any tool</option>
                {toolFacets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="agent"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Agent
              </Label>
              <NativeSelect
                id="agent"
                name="agent"
                defaultValue={agentFilter}
              >
                <option value="">Any agent</option>
                {agentFacets.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </NativeSelect>
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
        hiddenParams={paginationParams}
      />
    </div>
  );
}
