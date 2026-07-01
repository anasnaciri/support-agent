import { api } from "@/lib/api-client";
import { useCaseMutation } from "@/lib/use-case-mutation";
import { Button } from "@/components/ui/button";

// Re-send the SAME drafted reply whose delivery failed (requeues the failed
// reply-delivery for the worker sweep). Rendered inside the deliveryFailed
// timeline card.
export function RetrySendButton({
  workspaceId,
  caseId,
}: {
  readonly workspaceId: string;
  readonly caseId: string;
}) {
  const m = useCaseMutation({
    workspaceId,
    caseId,
    action: "retrySend",
    mutationFn: () => api.retrySend({ workspaceId }, caseId),
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
