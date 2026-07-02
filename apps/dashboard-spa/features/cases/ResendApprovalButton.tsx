import { api } from "@/lib/api-client";
import { useCaseMutation } from "@/lib/use-case-mutation";
import { Button } from "@/components/ui/button";

// Resend an approved reply that was never sent (it was skipped when the case was
// taken over). Re-sends the EXACT approved draft on the same thread; the case
// stays in human_takeover. Rendered inside the approvedNotSent timeline card.
export function ResendApprovalButton({
  workspaceId,
  caseId,
}: {
  readonly workspaceId: string;
  readonly caseId: string;
}) {
  const m = useCaseMutation({
    workspaceId,
    caseId,
    action: "resendApproval",
    mutationFn: () => api.resendApproval({ workspaceId }, caseId),
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
