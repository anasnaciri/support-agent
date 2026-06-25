"use client";

import { useState } from "react";
import { Ban, HandCoins, SlidersHorizontal } from "lucide-react";

import type {
  DiscountPolicyMode,
  DiscountPolicyView,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";

import { saveDiscountPolicyAction } from "./actions";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

// Client component because the mode selector toggles the threshold inputs
// between active and disabled in the browser. Disabled inputs don't post, so
// in the non-threshold modes we mirror their controlled values into hidden
// inputs — switching to always-ask / always-deny and saving still preserves
// the merchant's thresholds for when they switch back.
export const DiscountPolicyForm = ({
  policy,
}: {
  policy: DiscountPolicyView;
}) => {
  const [mode, setMode] = useState<DiscountPolicyMode>(policy.mode);
  const [askPct, setAskPct] = useState(String(policy.askAbovePercentage));
  const [maxPct, setMaxPct] = useState(String(policy.maxPercentage));
  const [askAmt, setAskAmt] = useState(
    minorToMajor(policy.askAboveFixedAmountMinorUnits),
  );
  const [maxAmt, setMaxAmt] = useState(
    minorToMajor(policy.maxFixedAmountMinorUnits),
  );

  const thresholdsActive = mode === "thresholds";

  const optionClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
      selected ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
    );

  const muted = (active: boolean) => cn(!active && "text-muted-foreground");

  return (
    <form action={saveDiscountPolicyAction} className="space-y-4">
      <div className="grid gap-4 sm:max-w-lg sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="currencyCode">Currency</Label>
          <Input
            id="currencyCode"
            name="currencyCode"
            type="text"
            inputMode="text"
            autoComplete="off"
            maxLength={3}
            defaultValue={policy.currencyCode}
            required
            aria-describedby="currency-hint"
          />
          <p id="currency-hint" className="text-xs text-muted-foreground">
            ISO 4217. Used for fixed-amount coupons.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="maxValidityDays">Expires after (days)</Label>
          <Input
            id="maxValidityDays"
            name="maxValidityDays"
            type="text"
            inputMode="numeric"
            defaultValue={String(policy.maxValidityDays)}
            required
            aria-describedby="validity-hint"
          />
          <p id="validity-hint" className="text-xs text-muted-foreground">
            Every coupon expires this many days after it&apos;s issued. Applies
            in all modes.
          </p>
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Discount handling</legend>

        {/* Use thresholds */}
        <label className={optionClass(thresholdsActive)}>
          <input
            type="radio"
            name="mode"
            value="thresholds"
            checked={thresholdsActive}
            onChange={() => setMode("thresholds")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid w-full gap-3">
            <span className="grid gap-1">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <SlidersHorizontal className="size-4" aria-hidden />
                Use thresholds
              </span>
              <span className="text-xs text-muted-foreground">
                Auto-issue small coupons, pause mid-size ones for approval,
                block large ones — by discount value.
              </span>
            </span>

            <span className="grid gap-4 sm:grid-cols-2 sm:max-w-lg">
              <span className="grid gap-2">
                <Label htmlFor="askAbovePercentage" className={muted(thresholdsActive)}>
                  Auto up to (%)
                </Label>
                <Input
                  id="askAbovePercentage"
                  name="askAbovePercentage"
                  type="text"
                  inputMode="decimal"
                  value={askPct}
                  onChange={(e) => setAskPct(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                />
                <span className="text-xs text-muted-foreground">
                  At or below this percent auto-issues.
                </span>
              </span>
              <span className="grid gap-2">
                <Label htmlFor="maxPercentage" className={muted(thresholdsActive)}>
                  Block above (%)
                </Label>
                <Input
                  id="maxPercentage"
                  name="maxPercentage"
                  type="text"
                  inputMode="decimal"
                  value={maxPct}
                  onChange={(e) => setMaxPct(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                />
                <span className="text-xs text-muted-foreground">
                  Hard cap. Above this never runs, even with approval.
                </span>
              </span>
              <span className="grid gap-2">
                <Label htmlFor="askAboveFixedAmount" className={muted(thresholdsActive)}>
                  Auto up to (amount)
                </Label>
                <Input
                  id="askAboveFixedAmount"
                  name="askAboveFixedAmount"
                  type="text"
                  inputMode="decimal"
                  value={askAmt}
                  onChange={(e) => setAskAmt(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                />
                <span className="text-xs text-muted-foreground">
                  Fixed-amount coupons at or below this auto-issue.
                </span>
              </span>
              <span className="grid gap-2">
                <Label htmlFor="maxFixedAmount" className={muted(thresholdsActive)}>
                  Block above (amount)
                </Label>
                <Input
                  id="maxFixedAmount"
                  name="maxFixedAmount"
                  type="text"
                  inputMode="decimal"
                  value={maxAmt}
                  onChange={(e) => setMaxAmt(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                />
                <span className="text-xs text-muted-foreground">
                  Hard cap on fixed-amount coupons.
                </span>
              </span>
            </span>
          </span>
        </label>

        {/* Always ask */}
        <label className={optionClass(mode === "always_ask")}>
          <input
            type="radio"
            name="mode"
            value="always_ask"
            checked={mode === "always_ask"}
            onChange={() => setMode("always_ask")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <HandCoins className="size-4" aria-hidden />
              Always ask
            </span>
            <span className="text-xs text-muted-foreground">
              Every coupon waits for your approval, regardless of value. The
              agent drafts it; a human approves before it&apos;s issued.
            </span>
          </span>
        </label>

        {/* Always deny */}
        <label className={optionClass(mode === "always_deny")}>
          <input
            type="radio"
            name="mode"
            value="always_deny"
            checked={mode === "always_deny"}
            onChange={() => setMode("always_deny")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Ban className="size-4 text-destructive" aria-hidden />
              Always deny
            </span>
            <span className="text-xs text-muted-foreground">
              Block every coupon. The agent never issues one — it drafts a
              reply instead, and you handle goodwill gestures yourself.
            </span>
          </span>
        </label>
      </fieldset>

      {/* Disabled inputs don't post — mirror the retained thresholds so the
          server keeps them while a non-threshold mode is selected. */}
      {!thresholdsActive ? (
        <>
          <input type="hidden" name="askAbovePercentage" value={askPct} />
          <input type="hidden" name="maxPercentage" value={maxPct} />
          <input type="hidden" name="askAboveFixedAmount" value={askAmt} />
          <input type="hidden" name="maxFixedAmount" value={maxAmt} />
        </>
      ) : null}

      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
};
