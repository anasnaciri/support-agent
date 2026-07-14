import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { ReturnShippingPayerView } from "@support-agent/dashboard-contracts";
import type { WizardStepProps } from "../steps";

// Step 3. The numbers a reply depends on. These are the highest-leverage
// minutes in the whole wizard: with them the agent quotes the merchant's real
// delivery window and return window; without them it searches the documents and
// hedges.
//
// A deliberately SHORTER form than /settings/facts: only the fields the decoders
// treat as required (`delayedAfterDays`, `returnWindowDays`) plus the two the
// agent quotes most. Everything else stays on the settings page, which the copy
// below points at. Both blocks save through the same endpoints that page uses.

const hint = "text-xs text-muted-foreground";

const isReturnShippingPayer = (
  v: string | null,
): v is ReturnShippingPayerView =>
  v === "customer" || v === "merchant" || v === "depends";

export function FactsStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
  });

  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const num = (k: string) => {
        const v = String(form.get(k) ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const text = (k: string) => {
        const v = String(form.get(k) ?? "").trim();
        return v === "" ? null : v;
      };

      // Both blocks are all-or-nothing on ONE field each (that's what the
      // decoders enforce): without it the block reads back as null and the
      // agent falls back to searching the documents. So we only send a block
      // when its required field is present.
      const delayedAfterDays = num("delayedAfterDays");
      const returnWindowDays = num("returnWindowDays");

      if (delayedAfterDays !== null) {
        await api.setShippingFacts(ctx, {
          processingTime: text("processingTime") ?? "",
          deliveryTime: text("deliveryTime") ?? "",
          shippingCost: text("shippingCost"),
          customsDuties: null,
          delayedAfterDays,
          lostPackageInvestigationDays: num("lostPackageInvestigationDays"),
        });
      }
      if (returnWindowDays !== null) {
        const payer = text("returnShippingPayer");
        await api.setReturnsFacts(ctx, {
          returnWindowDays,
          returnShippingPayer: isReturnShippingPayer(payer) ? payer : null,
          refundMethod: null,
          refundProcessingTime: text("refundProcessingTime"),
        });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
      onDone();
    },
    onError: () =>
      toast.warning("Couldn't save those facts. Please try again."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save.mutate(new FormData(e.currentTarget));
  };

  if (settings.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const shipping = settings.data?.shippingFacts ?? null;
  const returns = settings.data?.returnsFacts ?? null;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Shipping &amp; delivery</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-0 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="processingTime">Time to process an order</Label>
            <Input
              id="processingTime"
              name="processingTime"
              defaultValue={shipping?.processingTime ?? ""}
              placeholder="1-2 business days"
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="deliveryTime">Time in transit</Label>
            <Input
              id="deliveryTime"
              name="deliveryTime"
              defaultValue={shipping?.deliveryTime ?? ""}
              placeholder="7-12 days"
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="shippingCost">Shipping cost</Label>
            <Input
              id="shippingCost"
              name="shippingCost"
              defaultValue={shipping?.shippingCost ?? ""}
              placeholder="Free over $50"
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="delayedAfterDays">An order is late after</Label>
            <Input
              id="delayedAfterDays"
              name="delayedAfterDays"
              type="number"
              min={1}
              defaultValue={shipping?.delayedAfterDays ?? ""}
              placeholder="14"
              disabled={!canEdit}
            />
            <p className={hint}>
              Days in transit. Past this the agent stops reassuring the customer
              and treats it as a delivery problem.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Returns &amp; refunds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-0 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="returnWindowDays">Returns accepted within</Label>
            <Input
              id="returnWindowDays"
              name="returnWindowDays"
              type="number"
              min={1}
              defaultValue={returns?.returnWindowDays ?? ""}
              placeholder="30"
              disabled={!canEdit}
            />
            <p className={hint}>Days after delivery.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="returnShippingPayer">Return shipping paid by</Label>
            <NativeSelect
              id="returnShippingPayer"
              name="returnShippingPayer"
              defaultValue={returns?.returnShippingPayer ?? ""}
              disabled={!canEdit}
            >
              <option value="">Not sure yet</option>
              <option value="customer">The customer</option>
              <option value="merchant">Us</option>
              <option value="depends">It depends</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="refundProcessingTime">
              How long a refund takes to land
            </Label>
            <Input
              id="refundProcessingTime"
              name="refundProcessingTime"
              defaultValue={returns?.refundProcessingTime ?? ""}
              placeholder="5-7 business days after we receive the item"
              disabled={!canEdit}
            />
          </div>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        There are a few more facts (customs, lost-package handling) on the Store
        facts page. You can fill them in whenever you like.
      </p>

      <Button type="submit" disabled={!canEdit || save.isPending}>
        {save.isPending && <Loader2 className="size-4 animate-spin" />}
        Save and continue
      </Button>
    </form>
  );
}
