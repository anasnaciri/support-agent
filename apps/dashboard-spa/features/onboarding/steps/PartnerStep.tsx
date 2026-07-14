import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Truck } from "lucide-react";

import { api } from "@/lib/api-client";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WizardStepProps } from "../steps";

// Step 11. The last one, and the one most merchants will skip.
//
// A fulfillment partner is whoever actually ships the orders. Inviting them
// gives the agent somewhere to go when a shipment is the problem: it asks them
// about the package, waits for the answer, and only then replies to the
// customer. Without one, those tickets come to the merchant instead — which is
// a perfectly reasonable place for them to go.

export function PartnerStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();

  const invite = useMutation({
    mutationFn: (input: { email: string; name?: string }) =>
      api.inviteFulfillmentOperator(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning("Couldn't send that invite. Please try again.");
        return;
      }
      toast.success("Invite sent.");
      onDone();
    },
    onError: () => toast.warning("Couldn't send that invite."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    if (!email) return;
    invite.mutate(name ? { email, name } : { email });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Who they are</Label>
          <Input
            id="name"
            name="name"
            placeholder="e.g. Shenzhen Logistics"
            disabled={!canEdit}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">Their email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="ops@partner.com"
            disabled={!canEdit}
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        They get their own limited page showing only the shipments the agent asks
        them about. They never see your customers or your store. Ship your own
        orders? Skip this.
      </p>

      <Button type="submit" disabled={!canEdit || invite.isPending}>
        {invite.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Truck className="size-4" />
        )}
        Send invite
      </Button>
    </form>
  );
}
