import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { useTableState } from "@/lib/use-table-state";
import { auditActionLabel } from "@/lib/labels";
import { actorVariant } from "@/lib/status-variants";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
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
  { label: "Actions taken", value: "tool.invoked" },
  { label: "Agent decisions", value: "llm.decision" },
  { label: "Messages received", value: "event.received" },
  { label: "Cases resolved", value: "case.resolved" },
  { label: "Escalated to you", value: "case.escalated_to_human" },
  { label: "Data & privacy requests", value: "compliance." },
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

export function AuditPage() {
  const allowed = useRequirePermission("audit.view");
  const ctx = useWorkspaceCtx();
  const { page, pageSize, setPage, setPageSize, resetPage } = useTableState();
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");

  const filter = {
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(actorFilter ? { actor: actorFilter } : {}),
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.audit(ctx.workspaceId, filter, page, pageSize),
    queryFn: () => api.audit(ctx, filter, page, pageSize),
    enabled: allowed,
  });

  if (!allowed) return null;

  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageBreadcrumb current="Audit log" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything that happened across your cases, newest first.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr] lg:items-end">
            <div className="space-y-1.5">
              <Label
                htmlFor="action"
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Action
              </Label>
              <NativeSelect
                id="action"
                name="action"
                value={actionFilter}
                onChange={(e) => {
                  setActionFilter(e.currentTarget.value);
                  resetPage();
                }}
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
                className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground"
              >
                Actor
              </Label>
              <NativeSelect
                id="actor"
                name="actor"
                value={actorFilter}
                onChange={(e) => {
                  setActorFilter(e.currentTarget.value);
                  resetPage();
                }}
              >
                {ACTOR_FILTERS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
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
                  Couldn’t load the audit log.
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
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
                    <span className="text-xs">{auditActionLabel(r.action)}</span>
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
        page={page}
        pageSize={pageSize}
        totalRows={data?.totalRows ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
