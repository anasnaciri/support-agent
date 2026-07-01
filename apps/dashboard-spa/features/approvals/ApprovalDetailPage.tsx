import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Clock } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { approvalStatusLabel, toolActionLabel } from "@/lib/labels";
import { approvalStatusVariant, riskVariant } from "@/lib/status-variants";
import { draftStaleness } from "@/lib/draft-staleness";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

// ⚠️ Phase 3 = READ-ONLY. The approve/reject decision controls (the Next page's
// server-action forms) land in Phase 4; a pending approval shows a read-only
// note in their place. Everything else — reasoning, proposed input, staleness,
// the decided summary — is the faithful display port.

export function ApprovalDetailPage() {
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { approvalId?: string }).approvalId ?? "";

  const { data: row, isLoading } = useQuery({
    queryKey: qk.approval(ctx.workspaceId, id),
    queryFn: () => api.approvalDetail(ctx, id),
    enabled: id.length > 0,
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
            case:{" "}
            <Link
              href={`/cases/${row.caseId}`}
              className="font-mono text-primary hover:underline"
            >
              {row.caseId.slice(0, 8)}…
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
          <CardTitle>Reasoning</CardTitle>
        </CardHeader>
        <CardContent>
          {row.reasoning ? (
            <p className="text-sm">{row.reasoning}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              (no reasoning recorded)
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Proposed input</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
            {JSON.stringify(row.proposedInput, null, 2)}
          </pre>
        </CardContent>
      </Card>

      {isPending ? (
        <Card>
          <CardHeader>
            <CardTitle>Decision</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Approve / reject controls arrive in a later update. Until then,
              decide this approval from the case view.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Decided{" "}
              {row.decidedAt
                ? row.decidedAt.slice(0, 19).replace("T", " ")
                : "(no timestamp)"}
              {row.decidedBy ? ` by ${row.decidedBy}` : ""}.
              {row.approvedInput &&
              typeof row.approvedInput === "object" &&
              "bodyText" in (row.approvedInput as Record<string, unknown>)
                ? " Manager edited the body text before approving."
                : null}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
