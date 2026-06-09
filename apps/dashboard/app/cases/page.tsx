import Link from "next/link";
import { cookies } from "next/headers";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  parsePageNumber,
  resolveDefaultPageSize,
  resolvePageSize,
  ROWS_COOKIE,
} from "@/lib/pagination";
import { caseStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
    readonly page?: string;
    readonly limit?: string;
  }>;
}

export default async function CasesPage({ searchParams }: SearchParams) {
  const ctx = await getDashboardContext();
  const sp = await searchParams;
  const cookieRows = (await cookies()).get(ROWS_COOKIE)?.value;
  const defaultPageSize = resolveDefaultPageSize(cookieRows);
  const pageSize = resolvePageSize(sp.limit, cookieRows);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows } = await api.cases(
    ctx,
    requestedPage,
    pageSize,
  );

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
                  No cases yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/cases/${r.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {r.subject ?? "(no subject)"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={caseStatusVariant(r.status)}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.category ?? "—"}
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
      />
    </div>
  );
}
