import { useState } from "react";
import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import { Layers } from "lucide-react";

import { api } from "@/lib/api-client";
import { useApprovalDecision, useBundleDecision } from "@/lib/use-ticket-mutation";
import { toolActionLabel } from "@/lib/labels";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton } from "./ConfirmButton";

/**
 * Bundle approval control (autonomous loop). When the scenario agent queues
 * several gated actions on one ticket, the operator can approve them all at once
 * ("Approve all" / "Reject remaining" via the ticket-scoped bundle endpoint) OR
 * accept them one at a time (the per-row single-approval endpoint). Accepting
 * one runs THAT action now; the ticket stays parked until every action is decided.
 * Rendered only when there's more than one pending approval.
 */
interface Props {
  readonly workspaceId: string;
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

function BundleRow({
  workspaceId,
  ticketId,
  approval,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly approval: ApprovalDetail;
}) {
  const isReply = approval.tool === "conversation.reply";
  const [bodyText, setBodyText] = useState(() => replyBodyText(approval));
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;

  const acceptM = useApprovalDecision({
    workspaceId,
    ticketId,
    action: "approve",
    mutationFn: () =>
      api.approveApproval(
        { workspaceId },
        approval.id,
        isReply && proposed ? { ...proposed, bodyText } : undefined,
      ),
  });

  return (
    <li className="space-y-2">
      <div className="text-sm font-medium">{toolActionLabel(approval.tool)}</div>
      {isReply ? (
        <div className="space-y-1.5">
          <Label htmlFor={`reply-${approval.id}`}>Customer reply</Label>
          <Textarea
            id={`reply-${approval.id}`}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={5}
          />
        </div>
      ) : null}
      {MONEY_TOOLS.has(approval.tool) ? (
        <ConfirmButton
          variant="secondary"
          title={`Accept "${toolActionLabel(approval.tool)}" now?`}
          description="This action runs now and may move money. The ticket stays open until the other queued actions are decided."
          confirmLabel="Accept"
          pending={acceptM.isPending}
          onConfirm={() => acceptM.mutate()}
        >
          Accept
        </ConfirmButton>
      ) : (
        <Button
          variant="secondary"
          onClick={() => acceptM.mutate()}
          disabled={acceptM.isPending}
        >
          {acceptM.isPending ? "Accepting…" : "Accept"}
        </Button>
      )}
    </li>
  );
}

export function BundleApprovalBar({ workspaceId, ticketId, pending }: Props) {
  const approveAllM = useBundleDecision({
    workspaceId,
    ticketId,
    action: "approve",
    mutationFn: () => api.approveTicketBundle({ workspaceId }, ticketId),
  });
  const rejectAllM = useBundleDecision({
    workspaceId,
    ticketId,
    action: "reject",
    mutationFn: () => api.rejectTicketBundle({ workspaceId }, ticketId),
  });

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
        <div className="flex flex-wrap gap-2">
          <ConfirmButton
            variant="default"
            title={`Approve all ${pending.length} actions?`}
            description="Each queued action runs in order. Anything that moves money (a refund) executes against Shopify, and the customer reply is sent. This can't be undone from here."
            confirmLabel="Approve all"
            pending={approveAllM.isPending}
            onConfirm={() => approveAllM.mutate()}
          >
            Approve all
          </ConfirmButton>
          <ConfirmButton
            variant="outline"
            title="Reject the remaining actions?"
            description="The actions you haven't accepted won't run, and the ticket moves to human takeover for you to handle. Anything you already accepted stays done."
            confirmLabel="Reject remaining"
            pending={rejectAllM.isPending}
            onConfirm={() => rejectAllM.mutate()}
          >
            Reject remaining
          </ConfirmButton>
        </div>

        <Separator />

        <ul className="space-y-4">
          {pending.map((a) => (
            <BundleRow
              key={a.id}
              workspaceId={workspaceId}
              ticketId={ticketId}
              approval={a}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
