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
  ticketStatusFilterOptions,
  ticketStatusLabel,
  ticketSubjectLabel,
  hasSubject,
  humanizeSlug,
} from "@/lib/labels";
import { cn } from "@/lib/utils";
import {
  ticketsHiddenParams,
  isDefaultTicketsFilter,
  toFilterValues,
} from "@/lib/tickets-filters";
import { ticketStatusVariant } from "@/lib/status-variants";
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

export default async function TicketsPage({ searchParams }: SearchParams) {
  const ctx = await getDashboardContext();
  const sp = await searchParams;
  const statusValues = toFilterValues(sp.status);
  const cookieRows = (await cookies()).get(ROWS_COOKIE)?.value;
  const defaultPageSize = resolveDefaultPageSize(cookieRows);
  const pageSize = resolvePageSize(sp.limit, cookieRows);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows } = await api.tickets(
    ctx,
    { status: statusValues },
    requestedPage,
    pageSize,
  );

  const isReset = isDefaultTicketsFilter(statusValues);

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Tickets" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Tickets</h1>
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
                options={ticketStatusFilterOptions.map((o) => ({
                  label: o.label,
                  value: o.value,
                }))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit">Apply</Button>
              {!isReset ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/tickets">Reset</Link>
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
                  {isReset ? "No tickets yet." : "No tickets match these filters."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/tickets/${r.id}`}
                      className={cn(
                        "font-medium text-primary hover:underline",
                        !hasSubject(r.subject) &&
                          "font-normal italic text-muted-foreground",
                      )}
                    >
                      {ticketSubjectLabel(r.subject)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={ticketStatusVariant(r.status)}>
                        {ticketStatusLabel(r.status)}
                      </Badge>
                      {/* Concurrent wait: a ticket parked waiting_for_approval
                          can also carry an open fulfillment partner escalation. */}
                      {extraWaitChips(r.status, r.waitingOn).map((s) => (
                        <Badge key={s} variant={ticketStatusVariant(s)}>
                          {ticketStatusLabel(s)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.scenarioKey ? humanizeSlug(r.scenarioKey) : "—"}
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
        pathname="/tickets"
        page={page}
        pageSize={pageSize}
        totalRows={totalRows}
        defaultPageSize={defaultPageSize}
        hiddenParams={ticketsHiddenParams(statusValues)}
      />
    </div>
  );
}
