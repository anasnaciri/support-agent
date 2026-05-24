import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { cases } from "@support-agent/db";

import { db } from "@/lib/db";
import {
  clampPage,
  parsePageNumber,
  parsePageSize,
} from "@/lib/pagination";
import { getTenantId } from "@/lib/tenant";
import { caseStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
  const tenantId = await getTenantId();
  const sp = await searchParams;
  const pageSize = parsePageSize(sp.limit);
  const requestedPage = parsePageNumber(sp.page);

  const [countRow] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.tenantId, tenantId));

  const totalRows = countRow?.count ?? 0;
  const page = clampPage(requestedPage, totalRows, pageSize);
  const rows = await db()
    .select({
      id: cases.id,
      subject: cases.subject,
      status: cases.status,
      category: cases.category,
      currentAgentId: cases.currentAgentId,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(eq(cases.tenantId, tenantId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return (
    <div className="space-y-6">
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
                    {r.updatedAt
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
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
      />
    </div>
  );
}
