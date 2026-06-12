import { notFound } from "next/navigation";
import Link from "next/link";

import { api, getDashboardContext } from "@/lib/api-client";
import { approvalStatusLabel, toolActionLabel } from "@/lib/labels";
import {
  approvalStatusVariant,
  riskVariant,
} from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

import { approveAction, rejectAction } from "./actions";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function ApprovalDetailPage({ params }: Params) {
  const { id } = await params;
  const ctx = await getDashboardContext();
  const row = await api.approvalDetail(ctx, id);
  if (!row) notFound();
  const isPending = row.status === "pending";
  const proposed =
    row.proposedInput && typeof row.proposedInput === "object"
      ? (row.proposedInput as Record<string, unknown>)
      : null;
  const editableBodyText =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;

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
          <Badge variant={riskVariant(row.riskLevel)}>
            Risk: {row.riskLevel}
          </Badge>
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
          <CardContent className="space-y-4">
            {editableBodyText !== null ? (
              <form action={approveAction} className="space-y-3">
                <input type="hidden" name="approvalId" value={row.id} />
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bodyText"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                  >
                    Reply body (edit before approving)
                  </Label>
                  <Textarea
                    id="bodyText"
                    name="bodyText"
                    defaultValue={editableBodyText}
                    rows={8}
                  />
                </div>
                <SubmitButton variant="success" pendingLabel="Approving…">
                  Approve
                </SubmitButton>
                <p className="text-xs text-muted-foreground">
                  What you approve here — including any edits you make above —
                  is exactly what's sent to the customer.
                </p>
              </form>
            ) : (
              <form action={approveAction}>
                <input type="hidden" name="approvalId" value={row.id} />
                <SubmitButton variant="success" pendingLabel="Approving…">
                  Approve
                </SubmitButton>
              </form>
            )}

            <form action={rejectAction}>
              <input type="hidden" name="approvalId" value={row.id} />
              <ConfirmSubmitButton
                title="Reject this approval?"
                description="No customer reply goes out, and the case escalates to human takeover — you'll handle it manually from there."
                confirmLabel="Reject & take over"
              >
                Reject
              </ConfirmSubmitButton>
            </form>

            <p className="text-sm text-muted-foreground">
              Approving sends the reply — with any edits you made — to the
              customer from your connected mailbox. Rejecting sends nothing
              and hands the case over to you.
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
