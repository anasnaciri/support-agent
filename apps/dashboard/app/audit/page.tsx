import Link from "next/link";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  DEFAULT_PAGE_SIZE,
  parsePageNumber,
  parsePageSize,
} from "@/lib/pagination";
import { actorVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { TablePagination } from "@/components/TablePagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ACTION_FILTERS = [
  { label: "Any action", value: "" },
  { label: "Tool invocations", value: "tool.invoked" },
  { label: "LLM decisions", value: "llm.decision" },
  { label: "Events received", value: "event.received" },
  { label: "Case resolved", value: "case.resolved" },
  { label: "Escalated to human", value: "case.escalated_to_human" },
  { label: "Compliance webhooks", value: "compliance." },
] as const;

const ACTOR_FILTERS = [
  { label: "Any actor", value: "" },
  { label: "System", value: "system" },
  { label: "Agent", value: "agent" },
  { label: "User (manager)", value: "user" },
] as const;

const formatDetails = (details: unknown): string => {
  if (!details || typeof details !== "object") return "";
  const obj = details as Record<string, unknown>;
  const interesting: Array<[string, string]> = [];
  for (const k of [
    "tool",
    "target",
    "decisionType",
    "eventType",
    "viaApprovalId",
    "ok",
  ] as const) {
    if (k in obj) interesting.push([k, String(obj[k])]);
  }
  if (interesting.length > 0) {
    return interesting.map(([k, v]) => `${k}=${v}`).join(" · ");
  }
  try {
    return JSON.stringify(obj).slice(0, 120);
  } catch {
    return "";
  }
};

interface SearchParams {
  readonly searchParams: Promise<{
    readonly action?: string;
    readonly actor?: string;
    readonly page?: string;
    readonly limit?: string;
  }>;
}

export default async function AuditLogPage({ searchParams }: SearchParams) {
  const ctx = await getDashboardContext();
  const sp = await searchParams;
  const actionFilter = sp.action ?? "";
  const actorFilter = sp.actor ?? "";
  const pageSize = parsePageSize(sp.limit);
  const requestedPage = parsePageNumber(sp.page);

  const { totalRows, page, rows } = await api.audit(
    ctx,
    {
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(actorFilter ? { actor: actorFilter } : {}),
    },
    requestedPage,
    pageSize,
  );

  const paginationParams: ReadonlyArray<readonly [string, string]> = [
    ["action", actionFilter],
    ["actor", actorFilter],
  ];

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Audit log" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cross-case chronological view. Tenant-scoped, newest first.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <form
            method="get"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end"
          >
            {pageSize !== DEFAULT_PAGE_SIZE ? (
              <input type="hidden" name="limit" value={pageSize} />
            ) : null}
            <div className="space-y-1.5">
              <Label
                htmlFor="action"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Action
              </Label>
              <NativeSelect
                id="action"
                name="action"
                defaultValue={actionFilter}
              >
                {ACTION_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="actor"
                className="text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                Actor
              </Label>
              <NativeSelect id="actor" name="actor" defaultValue={actorFilter}>
                {ACTOR_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-sm italic text-muted-foreground"
                >
                  No audit entries match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="tabular-nums text-xs text-muted-foreground">
                    {r.occurredAt.slice(0, 19).replace("T", " ")}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {r.action}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={actorVariant(r.actorType)}>
                        {r.actorType}
                      </Badge>
                      {r.actorId ? (
                        <span className="text-xs text-muted-foreground">
                          {r.actorId}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.caseId ? (
                      <Link
                        href={`/cases/${r.caseId}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {r.caseId.slice(0, 8)}…
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDetails(r.details)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <TablePagination
        pathname="/audit"
        page={page}
        pageSize={pageSize}
        totalRows={totalRows}
        hiddenParams={paginationParams}
      />
    </div>
  );
}
