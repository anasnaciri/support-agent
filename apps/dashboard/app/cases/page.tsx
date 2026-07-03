import Link from "next/link";
import { cookies } from "next/headers";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  parsePageNumber,
  resolveDefaultPageSize,
  resolvePageSize,
  ROWS_COOKIE,
} from "@/lib/pagination";
import {
  caseStatusFilterOptions,
  caseStatusLabel,
  caseSubjectLabel,
  hasSubject,
  humanizeSlug,
} from "@/lib/labels";
import { cn } from "@/lib/utils";
import {
  casesHiddenParams,
  isDefaultCasesFilter,
  toFilterValues,
} from "@/lib/cases-filters";
import { caseStatusVariant } from "@/lib/status-variants";
import { extraWaitChips } from "@/lib/waiting-chips";
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

interface SearchParams {
  readonly searchParams: Promise<{
    readonly status?: string | string[];
    readonly page?: string;
    readonly limit?: string;
  }>;
}

export default async function CasesPage({ searchParams }: SearchParams) {
  const ctx = await getDashboardContext();
  const sp = await searchParams;
  const statusValues = toFilterValues(sp.status);
  const cookieRows = (await cookies()).get(ROWS_COOKIE)?.value;
  const defaultPageSize = resolveDefaultPageSize(cookieRows);
  const pageSize = resolvePageSize(sp.limit, cookieRows);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows } = await api.cases(
    ctx,
    { status: statusValues },
    requestedPage,
    pageSize,
  );

  const isReset = isDefaultCasesFilter(statusValues);

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
          <form
            method="get"
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            {pageSize !== defaultPageSize ? (
              <input type="hidden" name="limit" value={pageSize} />
            ) : null}
            <div className="space-y-1.5 sm:w-64">
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
                placeholder="Any status"
                allLabel="Any status"
                options={caseStatusFilterOptions.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit">Apply</Button>
              {!isReset ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/cases">Reset</Link>
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
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
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
        pathname="/cases"
        page={page}
        pageSize={pageSize}
        totalRows={totalRows}
        defaultPageSize={defaultPageSize}
        hiddenParams={casesHiddenParams(statusValues)}
      />
    </div>
  );
}
