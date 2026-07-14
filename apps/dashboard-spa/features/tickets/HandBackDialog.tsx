import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { HAND_BACK_OPTIONS, type HandBackChoice } from "@/lib/hand-back-options";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
 * "Hand back to the agent" (ticket-page Bot button): handing back never runs
 * the agent by itself, so the merchant picks what happens next — park the
 * ticket waiting on the customer's next message, or retry the agent's last
 * step right now. Without the choice, a hand-back used to leave the ticket
 * looking "in progress" while nothing was actually running.
 */
export function HandBackDialog({ workspaceId, ticketId, open, onOpenChange }: Props) {
  const ctx = { workspaceId };
  const waitM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "resume",
    mutationFn: () => api.resume(ctx, ticketId, { waitForCustomer: true }),
    onDone: () => onOpenChange(false),
  });
  const retryM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "retry",
    mutationFn: () => api.retry(ctx, ticketId),
    onDone: () => onOpenChange(false),
  });
  const mutationFor = (key: HandBackChoice) => (key === "wait" ? waitM : retryM);
  const anyPending = waitM.isPending || retryM.isPending;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !anyPending && onOpenChange(next)}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogTitle>Hand back to the agent</AlertDialogTitle>
        <AlertDialogDescription>
          How should the agent pick this ticket up?
        </AlertDialogDescription>
        <div className="flex flex-col gap-2">
          {HAND_BACK_OPTIONS.map((option) => {
            const m = mutationFor(option.key);
            return (
              <button
                key={option.key}
                type="button"
                disabled={anyPending}
                onClick={() => m.mutate()}
                className={cn(
                  "rounded-md border border-input p-3 text-left transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {m.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  {m.isPending ? option.pendingLabel : option.label}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            disabled={anyPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
