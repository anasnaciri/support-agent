import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useTableState } from "@/lib/use-table-state";
import {
  caseStatusFilterOptions,
  caseStatusLabel,
  caseSubjectLabel,
  hasSubject,
  humanizeSlug,
} from "@/lib/labels";
import { cn } from "@/lib/utils";
import { isDefaultCasesFilter } from "@/lib/cases-filters";
import { caseStatusVariant } from "@/lib/status-variants";
import { extraWaitChips } from "@/lib/waiting-chips";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { TablePagination } from "@/components/TablePagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function CasesPage() {
  const ctx = useWorkspaceCtx();
  const { page, pageSize, setPage, setPageSize, resetPage } = useTableState();
  const [statusValues, setStatusValues] = useState<ReadonlyArray<string>>([]);
  // Remount key for the MultiSelect so "Reset" clears its internal selection.
  const [filterKey, setFilterKey] = useState(0);

  const filter = { status: statusValues };
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.cases(ctx.workspaceId, filter, page, pageSize),
    queryFn: () => api.cases(ctx, filter, page, pageSize),
  });

  const rows = data?.rows ?? [];
  const isReset = isDefaultCasesFilter(statusValues);

  const reset = () => {
    setStatusValues([]);
    setFilterKey((k) => k + 1);
    resetPage();
  };

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Cases" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Cases</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Newest activity first. Showing up to {pageSize} per page.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5 sm:w-64">
              <Label
                htmlFor="status"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Status
              </Label>
              <MultiSelect
                key={filterKey}
                id="status"
                name="status"
                values={statusValues}
                placeholder="Any status"
                allLabel="Any status"
                options={caseStatusFilterOptions.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
                onChange={(next) => {
                  setStatusValues(next);
                  resetPage();
                }}
              />
            </div>
            {!isReset ? (
              <div className="flex items-end gap-2">
                <Button variant="ghost" size="sm" onClick={reset}>
                  Reset
                </Button>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-sm text-destructive"
                >
                  Couldn’t load cases.
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-sm italic text-muted-foreground"
                >
                  {isReset ? "No cases yet." : "No cases match these filters."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/cases/${r.id}`}
                      className={cn(
                        "font-medium text-primary hover:underline",
                        !hasSubject(r.subject) &&
                          "font-normal italic text-muted-foreground",
                      )}
                    >
                      {caseSubjectLabel(r.subject)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={caseStatusVariant(r.status)}>
                        {caseStatusLabel(r.status)}
                      </Badge>
                      {/* Concurrent wait: a case parked waiting_for_approval
                          can also carry an open supplier escalation. */}
                      {extraWaitChips(r.status, r.waitingOn).map((s) => (
                        <Badge key={s} variant={caseStatusVariant(s)}>
                          {caseStatusLabel(s)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.category ? humanizeSlug(r.category) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.currentAgentId}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {r.updatedAt.slice(0, 16).replace("T", " ")}
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
