import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import { Layers } from "lucide-react";

import { toolActionLabel } from "@/lib/labels";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

import {
  approveAction,
  approveBundleAction,
  rejectBundleAction,
} from "../../approvals/[id]/actions";

/**
 * Bundle approval control (autonomous loop). When the scenario agent queues
 * SEVERAL gated actions on one ticket, the operator can either approve them all at
 * once OR accept them one at a time:
 *   - "Approve all" / "Reject remaining" decide the whole pending set (the
 *     ticket-scoped bundle endpoint).
 *   - each action also has its own "Accept" (the per-row endpoint). Accepting one
 *     runs THAT action now; the ticket stays parked until every action is decided
 *     (the runtime never resolves a ticket with pending actions). "Reject
 *     remaining" then only rejects what's left — anything already accepted stays
 *     done.
 * The single customer reply (if any) stays editable. Rendered only when there is
 * more than one pending approval; a lone approval keeps the regular ApprovalCard.
 */
interface Props {
  readonly ticketId: string;
  readonly pending: ReadonlyArray<ApprovalDetail>;
}

const MONEY_TOOLS: ReadonlySet<string> = new Set([
  "refund.create",
  "discount.create",
  "order.cancel",
]);

const replyBodyText = (approval: ApprovalDetail): string => {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  return proposed && typeof proposed["bodyText"] === "string"
    ? (proposed["bodyText"] as string)
    : "";
};

export function BundleApprovalBar({ ticketId, pending }: Props) {
  const returnTo = `/tickets/${ticketId}`;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="size-4 text-primary" aria-hidden />
          <span>{pending.length} actions are queued for your approval</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Approve them all at once, or accept them one at a time. The ticket stays
          open until every action is decided.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Whole-bundle controls. */}
        <div className="flex flex-wrap gap-2">
          <form action={approveBundleAction}>
            <input type="hidden" name="ticketId" value={ticketId} />
            <ConfirmSubmitButton
              title={`Approve all ${pending.length} actions?`}
              description="Each queued action runs in order. Anything that moves money (a refund) executes against Shopify, and the customer reply is sent. This can't be undone from here."
              confirmLabel="Approve all"
            >
              Approve all
            </ConfirmSubmitButton>
          </form>
          <form action={rejectBundleAction}>
            <input type="hidden" name="ticketId" value={ticketId} />
            <ConfirmSubmitButton
              variant="outline"
              title="Reject the remaining actions?"
              description="The actions you haven't accepted won't run, and the ticket moves to human takeover for you to handle. Anything you already accepted stays done."
              confirmLabel="Reject remaining"
            >
              Reject remaining
            </ConfirmSubmitButton>
          </form>
        </div>

        <Separator />

        {/* Per-action accept. Accepting one runs it now; the ticket stays parked
            until the rest are decided. */}
        <ul className="space-y-4">
          {pending.map((a) => {
            const isReply = a.tool === "conversation.reply";
            return (
              <li key={a.id} className="space-y-2">
                <div className="text-sm font-medium">
                  {toolActionLabel(a.tool)}
                </div>
                <form action={approveAction} className="space-y-2">
                  <input type="hidden" name="approvalId" value={a.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {isReply ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`reply-${a.id}`}>Customer reply</Label>
                      <Textarea
                        id={`reply-${a.id}`}
                        name="bodyText"
                        rows={5}
                        defaultValue={replyBodyText(a)}
                      />
                    </div>
                  ) : null}
                  {MONEY_TOOLS.has(a.tool) ? (
                    <ConfirmSubmitButton
                      variant="secondary"
                      title={`Accept "${toolActionLabel(a.tool)}" now?`}
                      description="This action runs now and may move money. The ticket stays open until the other queued actions are decided."
                      confirmLabel="Accept"
                    >
                      Accept
                    </ConfirmSubmitButton>
                  ) : (
                    <SubmitButton variant="secondary" pendingLabel="Accepting…">
                      Accept
                    </SubmitButton>
                  )}
                </form>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
