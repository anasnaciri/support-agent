"use client";

import { useState } from "react";
import { Ban, HandCoins, SlidersHorizontal } from "lucide-react";

import type {
  RefundPolicyMode,
  RefundPolicyView,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";

import { saveRefundPolicyAction } from "./actions";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

// The refund-policy control is a client component because the mode selector
// toggles the threshold inputs between active and disabled in the browser.
// Disabled inputs don't post, so in the non-threshold modes we mirror their
// (controlled) values into hidden inputs — that way switching to always-ask /
// always-deny and saving still preserves the merchant's thresholds for when
// they switch back.
export const RefundPolicyForm = ({ policy }: { policy: RefundPolicyView }) => {
  const [mode, setMode] = useState<RefundPolicyMode>(policy.mode);
  const [askAbove, setAskAbove] = useState(
    minorToMajor(policy.askAboveMinorUnits),
  );
  const [denyAbove, setDenyAbove] = useState(
    minorToMajor(policy.denyAboveMinorUnits),
  );

  const thresholdsActive = mode === "thresholds";

  const optionClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
      selected ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
    );

  return (
    <form action={saveRefundPolicyAction} className="space-y-4">
      <div className="grid gap-2 sm:max-w-xs">
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
          ISO 4217. Refunds in other currencies always pause for approval.
        </p>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Refund handling</legend>

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
                Auto-run small refunds, pause mid-size ones for approval, block
                large ones — by amount.
              </span>
            </span>

            <span className="grid gap-4 sm:grid-cols-2 sm:max-w-lg">
              <span className="grid gap-2">
                <Label
                  htmlFor="askAbove"
                  className={cn(!thresholdsActive && "text-muted-foreground")}
                >
                  Ask above
                </Label>
                <Input
                  id="askAbove"
                  name="askAbove"
                  type="text"
                  inputMode="decimal"
                  value={askAbove}
                  onChange={(e) => setAskAbove(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                  aria-describedby="ask-hint"
                />
                <span id="ask-hint" className="text-xs text-muted-foreground">
                  At or below this amount auto-runs.
                </span>
              </span>
              <span className="grid gap-2">
                <Label
                  htmlFor="denyAbove"
                  className={cn(!thresholdsActive && "text-muted-foreground")}
                >
                  Deny above
                </Label>
                <Input
                  id="denyAbove"
                  name="denyAbove"
                  type="text"
                  inputMode="decimal"
                  value={denyAbove}
                  onChange={(e) => setDenyAbove(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                  aria-describedby="deny-hint"
                />
                <span id="deny-hint" className="text-xs text-muted-foreground">
                  Hard cap. Above this never runs, even with approval.
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
              Every refund waits for your approval, regardless of amount. The
              agent drafts it; a human approves before it runs.
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
              Block every refund. The agent never issues a refund — it drafts
              a reply instead, and you handle refunds yourself.
            </span>
          </span>
        </label>
      </fieldset>

      {/* Disabled inputs don't post — mirror the retained thresholds so the
          server keeps them while a non-threshold mode is selected. */}
      {!thresholdsActive ? (
        <>
          <input type="hidden" name="askAbove" value={askAbove} />
          <input type="hidden" name="denyAbove" value={denyAbove} />
        </>
      ) : null}

      <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
    </form>
  );
};
