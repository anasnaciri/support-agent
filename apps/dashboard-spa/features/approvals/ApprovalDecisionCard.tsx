import { useState } from "react";
import type { ApprovalDetail } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { useApprovalDecision } from "@/lib/use-ticket-mutation";
import { useAppNavigate } from "@/lib/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";

// The decision surface on the standalone approval-detail page. Rendered only
// once the approval has loaded (so the decision hooks always run), it mirrors
// the ticket-page approve/reject: edit-and-approve for a reply draft, a plain
// Approve otherwise, and a confirm-gated Reject. On a settled decision it
// returns to the approvals list (like the Next redirect); a decided approval
// shows a read-only summary instead.
export function ApprovalDecisionCard({
  approval,
  workspaceId,
}: {
  readonly approval: ApprovalDetail;
  readonly workspaceId: string;
}) {
  const nav = useAppNavigate();
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  const editableInitial =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;
  const [bodyText, setBodyText] = useState(editableInitial ?? "");

  const backToList = () => nav.push("/approvals");
  const approveM = useApprovalDecision({
    workspaceId,
    ticketId: approval.ticketId,
    action: "approve",
    mutationFn: () =>
      api.approveApproval(
        { workspaceId },
        approval.id,
        editableInitial !== null && proposed
          ? { ...proposed, bodyText }
          : undefined,
      ),
    onDone: backToList,
  });
  const rejectM = useApprovalDecision({
    workspaceId,
    ticketId: approval.ticketId,
    action: "reject",
    mutationFn: () => api.rejectApproval({ workspaceId }, approval.id),
    onDone: backToList,
  });

  if (approval.status !== "pending") {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            Decided{" "}
            {approval.decidedAt
              ? approval.decidedAt.slice(0, 19).replace("T", " ")
              : "(no timestamp)"}
            {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}.
            {approval.approvedInput &&
            typeof approval.approvedInput === "object" &&
            "bodyText" in (approval.approvedInput as Record<string, unknown>)
              ? " Manager edited the body text before approving."
              : null}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {editableInitial !== null ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="bodyText"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Reply body (edit before approving)
              </Label>
              <Textarea
                id="bodyText"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={8}
              />
            </div>
            <Button
              onClick={() => approveM.mutate()}
              disabled={approveM.isPending}
            >
              Approve
            </Button>
            <p className="text-xs text-muted-foreground">
              What you approve here — including any edits you make above — is
              exactly what&apos;s sent to the customer.
            </p>
          </div>
        ) : (
          <Button
            onClick={() => approveM.mutate()}
            disabled={approveM.isPending}
          >
            Approve
          </Button>
        )}

        <ConfirmButton
          title="Reject this approval?"
          description="No customer reply goes out, and the ticket escalates to human takeover — you'll handle it manually from there."
          confirmLabel="Reject & take over"
          pending={rejectM.isPending}
          onConfirm={() => rejectM.mutate()}
        >
          Reject
        </ConfirmButton>

        <p className="text-sm text-muted-foreground">
          Approving sends the reply — with any edits you made — to the customer
          from your connected mailbox. Rejecting sends nothing and hands the ticket
          over to you.
        </p>
      </CardContent>
    </Card>
  );
}
