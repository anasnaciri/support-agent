import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Clock } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { approvalStatusLabel, toolActionLabel } from "@/lib/labels";
import { approvalStatusVariant, riskVariant } from "@/lib/status-variants";
import { draftStaleness } from "@/lib/draft-staleness";
import { approvalDisplayNote } from "@/lib/approval-note";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { ApprovalDecisionCard } from "./ApprovalDecisionCard";

// The standalone approval-detail page: ticket note, staleness, and the decision
// surface (ApprovalDecisionCard — edit-and-approve / reject, wired to
// api.approveApproval / rejectApproval). A settled approval shows a read-only
// decided summary.

export function ApprovalDetailPage() {
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { approvalId?: string }).approvalId ?? "";

  const { data: row, isLoading } = useQuery({
    queryKey: qk.approval(ctx.workspaceId, id),
    queryFn: () => api.approvalDetail(ctx, id),
    enabled: id.length > 0,
  });
  const { data: ticketDetail } = useQuery({
    queryKey: qk.ticket(ctx.workspaceId, row?.ticketId ?? ""),
    queryFn: () => api.ticketDetail(ctx, row!.ticketId),
    enabled: Boolean(row?.ticketId),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!row) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Approval not found</p>
        <Button asChild size="sm" variant="outline">
          <Link href="/approvals">Back to approvals</Link>
        </Button>
      </div>
    );
  }

  const isPending = row.status === "pending";
  const staleness = isPending ? draftStaleness(row.createdAt) : null;
  const ticketContext = (ticketDetail?.ticket.context ?? {}) as Readonly<
    Record<string, unknown>
  >;
  const note = approvalDisplayNote(ticketContext);

  return (
    <div className="space-y-6">
      <PageBreadcrumb
        items={[{ href: "/approvals", label: "Approvals" }]}
        current={toolActionLabel(row.tool)}
      />

      <div>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          Approval
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          {toolActionLabel(row.tool)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={approvalStatusVariant(row.status)}>
            {approvalStatusLabel(row.status)}
          </Badge>
          <Badge variant={riskVariant(row.riskLevel)}>Risk: {row.riskLevel}</Badge>
          <span>·</span>
          <span>
            agent:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {row.agentId}
            </code>
          </span>
          <span>·</span>
          <span>
            ticket:{" "}
            <Link
              href={`/tickets/${row.ticketId}`}
              className="font-mono text-primary hover:underline"
            >
              {row.ticketId.slice(0, 8)}…
            </Link>
          </span>
        </div>
      </div>

      {staleness ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
          <Clock className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            Drafted {staleness.ageLabel} ago — the order, policy, or conversation
            may have changed since. Review before sending.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Note</CardTitle>
        </CardHeader>
        <CardContent>
          {note ? (
            <p className="whitespace-pre-wrap text-sm">{note}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              (no note recorded)
            </p>
          )}
        </CardContent>
      </Card>

      <ApprovalDecisionCard approval={row} workspaceId={ctx.workspaceId} />
    </div>
  );
}
