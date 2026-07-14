import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import { resolveRefundThresholds } from "@/lib/parse-thresholds";
import { parseValidityDays, resolveDiscountThresholds } from "@/lib/parse-discount";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WizardStepProps } from "../steps";
import type { DiscountPolicyMode, RefundPolicyMode } from "@support-agent/dashboard-contracts";

// Step 4. The money walls. Everything else in this wizard is grounding — this
// is enforcement: `PermissionService` reads these numbers before `refund.create`
// or `discount.create` ever runs, so a prompt can't talk its way past them.
//
// We ask in whole currency units and store minor units, which is the same
// contract /settings/refund-policy uses. Defaults are already sane (ask above
// $0, deny above $500), so a merchant who just clicks through is safe by
// construction: every refund gets queued for their approval.

const hint = "text-xs text-muted-foreground";

const toWhole = (minor: number): string => (minor / 100).toFixed(2);

const MODES = [
  { value: "thresholds", label: "Use thresholds", help: "Run small amounts automatically, ask in the middle, and block above the cap." },
  { value: "always_ask", label: "Always ask", help: "Hold every action for your approval, regardless of value." },
  { value: "always_deny", label: "Always deny", help: "Block every action; the agent drafts a reply instead." },
] as const;

function ModeChoices({ name, value, onChange, disabled }: {
  readonly name: string;
  readonly value: RefundPolicyMode | DiscountPolicyMode;
  readonly onChange: (value: "thresholds" | "always_ask" | "always_deny") => void;
  readonly disabled: boolean;
}) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-3">
      <legend className="sr-only">Handling mode</legend>
      {MODES.map((option) => (
        <label key={option.value} className={cn(
          "flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-[background-color,border-color,scale] duration-150 active:scale-[0.96]",
          value === option.value ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
          disabled && "cursor-not-allowed opacity-60",
        )}>
          <input type="radio" name={name} value={option.value} checked={value === option.value}
            onChange={() => onChange(option.value)} disabled={disabled} className="mt-0.5 size-4 shrink-0" />
          <span className="grid gap-1"><span className="text-sm font-medium">{option.label}</span>
            <span className="text-pretty text-xs text-muted-foreground">{option.help}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

export function PoliciesStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [refundMode, setRefundMode] = useState<RefundPolicyMode | null>(null);
  const [discountMode, setDiscountMode] = useState<DiscountPolicyMode | null>(null);

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

      if (!refund || !discount) throw new Error("policies unavailable");
      const effectiveRefundMode = refundMode ?? refund.mode;
      const effectiveDiscountMode = discountMode ?? discount.mode;
      const refundThresholds = resolveRefundThresholds({
        mode: effectiveRefundMode,
        askRaw: String(form.get("askAbove") ?? ""),
        denyRaw: String(form.get("denyAbove") ?? ""),
        stored: { askMinor: refund.askAboveMinorUnits, denyMinor: refund.denyAboveMinorUnits },
      });
      if (!refundThresholds.ok) throw new Error(refundThresholds.error);
      const discountThresholds = resolveDiscountThresholds({
        mode: effectiveDiscountMode,
        askPctRaw: String(form.get("askAbovePercentage") ?? ""),
        maxPctRaw: String(form.get("maxPercentage") ?? ""),
        askAmtRaw: String(form.get("askAboveFixedAmount") ?? ""),
        maxAmtRaw: String(form.get("maxFixedAmount") ?? ""),
        stored: {
          askPct: discount.askAbovePercentage, maxPct: discount.maxPercentage,
          askMinor: discount.askAboveFixedAmountMinorUnits, maxMinor: discount.maxFixedAmountMinorUnits,
        },
      });
      const validityDays = parseValidityDays(String(form.get("maxValidityDays") ?? ""));
      if (!discountThresholds.ok || validityDays === null) throw new Error("invalid discount policy");

      // Validate both forms before the first write so a malformed discount
      // cannot leave only the refund half of this combined step saved.
      const r = await api.setRefundPolicy(ctx, {
        currencyCode,
        askAboveMinorUnits: refundThresholds.askMinor,
        denyAboveMinorUnits: refundThresholds.denyMinor,
        mode: effectiveRefundMode,
      });
      if (r.status !== 200) throw new Error("refund policy rejected");
      const d = await api.setDiscountPolicy(ctx, {
        currencyCode,
        askAbovePercentage: discountThresholds.askPct,
        maxPercentage: discountThresholds.maxPct,
        askAboveFixedAmountMinorUnits: discountThresholds.askMinor,
        maxFixedAmountMinorUnits: discountThresholds.maxMinor,
        maxValidityDays: validityDays,
        mode: effectiveDiscountMode,
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
  const activeRefundMode = refundMode ?? refund?.mode ?? "thresholds";
  const activeDiscountMode = discountMode ?? discount?.mode ?? "thresholds";

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Refunds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <ModeChoices name="refundMode" value={activeRefundMode} onChange={setRefundMode} disabled={!canEdit} />
          <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="askAbove">Ask me before refunding more than</Label>
            <Input
              id="askAbove"
              name="askAbove"
              type="number"
              min={0}
              step="0.01"
              defaultValue={toWhole(refund?.askAboveMinorUnits ?? 0)}
              disabled={!canEdit || activeRefundMode !== "thresholds"}
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
              disabled={!canEdit || activeRefundMode !== "thresholds"}
            />
            <p className={hint}>
              {currency}. A hard ceiling: the agent cannot exceed it even with
              your approval.
            </p>
          </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Discounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <ModeChoices name="discountMode" value={activeDiscountMode} onChange={setDiscountMode} disabled={!canEdit} />
          <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="askAbovePercentage">Auto up to (%)</Label>
            <Input id="askAbovePercentage" name="askAbovePercentage" type="number" min={0} max={100} step="0.01"
              defaultValue={discount?.askAbovePercentage ?? 10} disabled={!canEdit || activeDiscountMode !== "thresholds"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="maxPercentage">Block above (%)</Label>
            <Input
              id="maxPercentage"
              name="maxPercentage"
              type="number"
              min={0}
              max={100}
              defaultValue={discount?.maxPercentage ?? 20}
              step="0.01"
              disabled={!canEdit || activeDiscountMode !== "thresholds"}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="askAboveFixedAmount">Auto up to ({currency})</Label>
            <Input id="askAboveFixedAmount" name="askAboveFixedAmount" type="number" min={0} step="0.01"
              defaultValue={toWhole(discount?.askAboveFixedAmountMinorUnits ?? 0)} disabled={!canEdit || activeDiscountMode !== "thresholds"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="maxFixedAmount">Block above ({currency})</Label>
            <Input id="maxFixedAmount" name="maxFixedAmount" type="number" min={0} step="0.01"
              defaultValue={toWhole(discount?.maxFixedAmountMinorUnits ?? 0)} disabled={!canEdit || activeDiscountMode !== "thresholds"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="maxValidityDays">Expires after (days)</Label>
            <Input id="maxValidityDays" name="maxValidityDays" type="number" min={1} max={365} step={1}
              defaultValue={discount?.maxValidityDays ?? 30} disabled={!canEdit} />
          </div>
          </div>
          <p className={hint}>Coupons are single-use, customer-locked, and cannot be combined.</p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        These are limits, not instructions: the agent only acts when a playbook
        says it should. Always ask holds every action for approval; always deny
        blocks it completely.
      </p>

      <Button type="submit" disabled={!canEdit || save.isPending}>
        {save.isPending && <Loader2 className="size-4 animate-spin" />}
        Save and continue
      </Button>
    </form>
  );
}
