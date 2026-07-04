import * as React from "react";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Props {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * "Escalate to supplier" (ticket-page ⋮ menu): the manager writes what the
 * supplier should do, and the ticket parks waiting on them — same machinery as
 * the agent's supplier.escalate tool (escalation row = notify outbox; the
 * supplier gets a portal link by email and their update re-engages the agent).
 */
export function EscalateSupplierDialog({
  workspaceId,
  ticketId,
  open,
  onOpenChange,
}: Props) {
  const [problem, setProblem] = React.useState("");

  const escalateM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "escalateSupplier",
    mutationFn: () => api.escalateSupplier({ workspaceId }, ticketId, problem),
    onDone: () => {
      setProblem("");
      onOpenChange(false);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogTitle>Escalate to supplier</AlertDialogTitle>
        <AlertDialogDescription>
          Hand this ticket to your warehouse or supplier. They get an email with a
          link to respond, and the ticket waits for their update before anything
          else happens.
        </AlertDialogDescription>
        <div className="space-y-2">
          <Label htmlFor="escalate-problem">What should they do?</Label>
          <Textarea
            id="escalate-problem"
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            rows={4}
            placeholder="e.g. Order #1001 seems lost in transit — please check with the carrier or reship."
            autoFocus
          />
          <p className="text-pretty text-xs text-muted-foreground">
            The supplier sees exactly this text — leave out the customer's
            personal details.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={escalateM.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => escalateM.mutate()}
            disabled={escalateM.isPending || problem.trim().length === 0}
          >
            {escalateM.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : null}
            Escalate
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
