import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { Button } from "@/components/ui/button";

// Resend an approved reply that was never sent (it was skipped when the ticket was
// taken over). Re-sends the EXACT approved draft on the same thread; the ticket
// stays in human_takeover. Rendered inside the approvedNotSent timeline card.
export function ResendApprovalButton({
  workspaceId,
  ticketId,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
}) {
  const m = useTicketMutation({
    workspaceId,
    ticketId,
    action: "resendApproval",
    mutationFn: () => api.resendApproval({ workspaceId }, ticketId),
  });
  return (
    <div className="pt-1">
      <Button
        size="sm"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        title="Send the approved reply that was never delivered to the customer"
      >
        {m.isPending ? "Sending…" : "Send approved reply"}
      </Button>
    </div>
  );
}
