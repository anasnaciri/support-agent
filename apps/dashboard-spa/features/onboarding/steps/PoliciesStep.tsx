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
import type { WizardStepProps } from "../steps";

// Step 4. The money walls. Everything else in this wizard is grounding — this
// is enforcement: `PermissionService` reads these numbers before `refund.create`
// or `discount.create` ever runs, so a prompt can't talk its way past them.
//
// We ask in whole currency units and store minor units, which is the same
// contract /settings/refund-policy uses. Defaults are already sane (ask above
// $0, deny above $500), so a merchant who just clicks through is safe by
// construction: every refund gets queued for their approval.

const hint = "text-xs text-muted-foreground";

/** Whole units → minor units, the storage contract shared with the settings page. */
const toMinor = (value: string, fallback: number): number => {
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : fallback;
};

const toWhole = (minor: number): string => (minor / 100).toFixed(2);

export function PoliciesStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
  });
  const shopCurrency = useQuery({
    queryKey: qk.shopCurrency(ctx.workspaceId),
    queryFn: () => api.shopCurrency(ctx),
  });

  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const refund = settings.data?.refundPolicy;
      const discount = settings.data?.discountPolicy;
      // Never invent a currency: use the store's, else whatever the policy was
      // already saved with. (The repo rule: no hardcoded USD.)
      const currencyCode =
        shopCurrency.data?.currencyCode ?? refund?.currencyCode ?? "";
      if (!currencyCode) {
        throw new Error("no currency");
      }

      const askAbove = toMinor(
        String(form.get("askAbove") ?? ""),
        refund?.askAboveMinorUnits ?? 0,
      );
      const denyAbove = toMinor(
        String(form.get("denyAbove") ?? ""),
        refund?.denyAboveMinorUnits ?? 0,
      );
      const r = await api.setRefundPolicy(ctx, {
        currencyCode,
        askAboveMinorUnits: askAbove,
        denyAboveMinorUnits: denyAbove,
        mode: refund?.mode ?? "thresholds",
      });
      if (r.status !== 200) throw new Error("refund policy rejected");

      const maxPercentage = Number(
        String(form.get("maxPercentage") ?? "").trim(),
      );
      const d = await api.setDiscountPolicy(ctx, {
        currencyCode,
        askAbovePercentage: discount?.askAbovePercentage ?? 10,
        maxPercentage: Number.isFinite(maxPercentage)
          ? maxPercentage
          : (discount?.maxPercentage ?? 20),
        askAboveFixedAmountMinorUnits:
          discount?.askAboveFixedAmountMinorUnits ?? 0,
        maxFixedAmountMinorUnits: discount?.maxFixedAmountMinorUnits ?? 0,
        maxValidityDays: discount?.maxValidityDays ?? 30,
        mode: discount?.mode ?? "thresholds",
      });
      if (d.status !== 200) throw new Error("discount policy rejected");
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
      onDone();
    },
    onError: () =>
      toast.warning("Couldn't save those limits. Please try again."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save.mutate(new FormData(e.currentTarget));
  };

  if (settings.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const refund = settings.data?.refundPolicy;
  const discount = settings.data?.discountPolicy;
  const currency =
    shopCurrency.data?.currencyCode ?? refund?.currencyCode ?? "";

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Refunds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-0 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="askAbove">Ask me before refunding more than</Label>
            <Input
              id="askAbove"
              name="askAbove"
              type="number"
              min={0}
              step="0.01"
              defaultValue={toWhole(refund?.askAboveMinorUnits ?? 0)}
              disabled={!canEdit}
            />
            <p className={hint}>
              {currency}. Set to 0 to approve every refund yourself.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="denyAbove">Never refund more than</Label>
            <Input
              id="denyAbove"
              name="denyAbove"
              type="number"
              min={0}
              step="0.01"
              defaultValue={toWhole(refund?.denyAboveMinorUnits ?? 0)}
              disabled={!canEdit}
            />
            <p className={hint}>
              {currency}. A hard ceiling: the agent cannot exceed it even with
              your approval.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Discounts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 pt-0 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="maxPercentage">Largest discount allowed</Label>
            <Input
              id="maxPercentage"
              name="maxPercentage"
              type="number"
              min={0}
              max={100}
              defaultValue={discount?.maxPercentage ?? 20}
              disabled={!canEdit}
            />
            <p className={hint}>
              Percent off. Coupons the agent creates are single-use, locked to
              the customer's order, and can't be combined.
            </p>
          </div>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        These are limits, not instructions: the agent still only refunds when a
        playbook says it should. You can tune the rest (currency, discount
        ceilings, expiry) in Settings later.
      </p>

      <Button type="submit" disabled={!canEdit || save.isPending}>
        {save.isPending && <Loader2 className="size-4 animate-spin" />}
        Save and continue
      </Button>
    </form>
  );
}
