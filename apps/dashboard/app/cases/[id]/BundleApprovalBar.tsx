import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import { Layers } from "lucide-react";

import { toolActionLabel } from "@/lib/labels";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  approveBundleAction,
  rejectBundleAction,
} from "../../approvals/[id]/actions";

/**
 * Bundle approval control (autonomous loop). When the scenario agent queues
 * SEVERAL gated actions on one case, they must be decided together: approving
 * them one-by-one would fire a per-row event and the runtime could resolve the
 * case while siblings are still pending (slice 4d). This bar approves/rejects
 * the WHOLE pending bundle in one click via the case-scoped endpoint, which
 * decides every row then publishes one event. The single customer reply (if
 * any) stays editable; its edit rides along as a per-row override.
 *
 * Rendered only when there is more than one pending approval — a lone approval
 * keeps the regular per-row ApprovalCard.
 */
interface Props {
  readonly caseId: string;
  readonly pending: ReadonlyArray<ApprovalDetail>;
}

const replyBodyText = (approval: ApprovalDetail): string => {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  return proposed && typeof proposed["bodyText"] === "string"
    ? (proposed["bodyText"] as string)
    : "";
};

export function BundleApprovalBar({ caseId, pending }: Props) {
  // The bundle's single customer reply, if there is exactly one — its body is
  // editable before approving. Zero or multiple replies → approve as proposed.
  const replyApprovals = pending.filter(
    (a) => a.tool === "conversation.reply",
  );
  const editableReply =
    replyApprovals.length === 1 ? replyApprovals[0]! : null;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="size-4 text-primary" aria-hidden />
          <span>
            {pending.length} actions are queued for your approval
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          The agent prepared these together. Approve them as one bundle to run
          them in order, or reject all to take the case over.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {pending.map((a) => (
            <li key={a.id}>{toolActionLabel(a.tool)}</li>
          ))}
        </ul>

        <form action={approveBundleAction} className="space-y-3">
          <input type="hidden" name="caseId" value={caseId} />
          {editableReply ? (
            <>
              <input
                type="hidden"
                name="replyApprovalId"
                value={editableReply.id}
              />
              <div className="space-y-1.5">
                <Label htmlFor="bundle-bodyText">Customer reply</Label>
                <Textarea
                  id="bundle-bodyText"
                  name="bodyText"
                  rows={6}
                  defaultValue={replyBodyText(editableReply)}
                />
              </div>
            </>
          ) : null}
          <ConfirmSubmitButton
            title={`Approve all ${pending.length} actions?`}
            description="Each queued action runs in order. Anything that moves money (a refund) executes against Shopify, and the customer reply is sent. This can't be undone from here."
            confirmLabel="Approve all"
          >
            Approve all
          </ConfirmSubmitButton>
        </form>

        <form action={rejectBundleAction}>
          <input type="hidden" name="caseId" value={caseId} />
          <ConfirmSubmitButton
            variant="outline"
            title="Reject all queued actions?"
            description="None of the queued actions run and the case moves to human takeover for you to handle."
            confirmLabel="Reject all"
          >
            Reject all
          </ConfirmSubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
