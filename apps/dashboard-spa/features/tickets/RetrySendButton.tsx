import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { Button } from "@/components/ui/button";

// Re-send the SAME drafted reply whose delivery failed (requeues the failed
// reply-delivery for the worker sweep). Rendered inside the deliveryFailed
// timeline card.
export function RetrySendButton({
  workspaceId,
  ticketId,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
}) {
  const m = useTicketMutation({
    workspaceId,
    ticketId,
    action: "retrySend",
    mutationFn: () => api.retrySend({ workspaceId }, ticketId),
  });
  return (
    <div className="pt-1">
      <Button
        size="sm"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        title="Re-send the same drafted reply that failed to deliver to the customer"
      >
        {m.isPending ? "Re-sending…" : "Retry sending email"}
      </Button>
    </div>
  );
}
