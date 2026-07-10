import * as React from "react";
import { Loader2 } from "lucide-react";

import { api, type CancelOrderReason } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Props {
  readonly workspaceId: string;
  readonly ticketId: string;
  /** The order name (e.g. "#1001"), shown in the trigger's tooltip + title. */
  readonly orderName: string;
  /** False when the order already shipped or is already cancelled. */
  readonly canCancel: boolean;
  /** Why the button is disabled; shown as its tooltip. */
  readonly disabledReason: string | null;
}

const REASONS: ReadonlyArray<{
  readonly value: CancelOrderReason;
  readonly label: string;
}> = [
  { value: "customer", label: "Customer changed their mind" },
  { value: "inventory", label: "Item out of stock" },
  { value: "fraud", label: "Suspected fraud" },
  { value: "declined", label: "Payment declined" },
  { value: "staff", label: "Staff error" },
  { value: "other", label: "Other" },
];

/**
 * The Order card's "Cancel" button + a confirm dialog mirroring the choices
 * Shopify's own cancel flow offers: refund the customer, restock the items, and
 * a reason recorded on the order timeline.
 *
 * Both toggles default ON — cancelling normally repays the customer and returns
 * the stock — and only an explicit un-tick withholds either (the api parses the
 * flags the same way). This is a REAL store write under the operator's
 * authority (`refunds.issue`), not an agent action, so it never asks the
 * customer's agent for anything; the operator tells the customer themselves.
 */
export function CancelOrderDialog({
  workspaceId,
  ticketId,
  orderName,
  canCancel,
  disabledReason,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [refund, setRefund] = React.useState(true);
  const [restock, setRestock] = React.useState(true);
  const [reason, setReason] = React.useState<CancelOrderReason>("customer");
  const [staffNote, setStaffNote] = React.useState("");

  const cancelM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "cancelOrder",
    mutationFn: () =>
      api.cancelOrder({ workspaceId }, ticketId, {
        refund,
        restock,
        reason,
        staffNote: staffNote.trim() ? staffNote.trim() : null,
      }),
    onDone: (kind) => {
      // Leave the dialog open on a Shopify rejection so the operator can see
      // the toast alongside the choices they made and adjust them.
      if (kind === "cancelled" || kind === "already_cancelled") setOpen(false);
    },
  });

  if (!canCancel) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        title={disabledReason ?? "This order can't be cancelled."}
      >
        Cancel
      </Button>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={`Cancel order ${orderName} in Shopify`}
        >
          Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Cancel order {orderName}</AlertDialogTitle>
        <AlertDialogDescription>
          This cancels the order in your store. It can&rsquo;t be undone.
        </AlertDialogDescription>

        <div className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input"
              checked={refund}
              onChange={(e) => setRefund(e.target.checked)}
            />
            <span>
              Refund the customer
              <span className="block text-xs text-muted-foreground">
                Returns the amount you captured for this order.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input"
              checked={restock}
              onChange={(e) => setRestock(e.target.checked)}
            />
            <span>
              Restock inventory
              <span className="block text-xs text-muted-foreground">
                Returns the items to the stock they were taken from.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor={`cancel-reason-${ticketId}`}>Reason</Label>
            <NativeSelect
              id={`cancel-reason-${ticketId}`}
              value={reason}
              onChange={(e) =>
                setReason(e.target.value as CancelOrderReason)
              }
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`cancel-note-${ticketId}`}>
              Staff note <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id={`cancel-note-${ticketId}`}
              rows={2}
              value={staffNote}
              onChange={(e) => setStaffNote(e.target.value)}
              placeholder="Recorded on the order timeline. The customer never sees this."
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={cancelM.isPending}
          >
            Keep order
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => cancelM.mutate()}
            disabled={cancelM.isPending}
          >
            {cancelM.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Cancel order
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
