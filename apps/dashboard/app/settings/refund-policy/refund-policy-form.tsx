"use client";

import { useState } from "react";
import { Ban } from "lucide-react";

import type { RefundPolicyView } from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveRefundPolicyAction } from "./actions";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

// The thresholds card is a client component because the "always deny"
// kill-switch toggles the threshold inputs between active and disabled in
// the browser. Disabled inputs don't post, so we mirror their (controlled)
// values into hidden inputs while disabled — that way flipping the switch on
// and saving still preserves the merchant's thresholds for when they turn it
// back off.
export const RefundPolicyForm = ({ policy }: { policy: RefundPolicyView }) => {
  const [alwaysDeny, setAlwaysDeny] = useState(policy.alwaysDeny);
  const [askAbove, setAskAbove] = useState(
    minorToMajor(policy.askAboveMinorUnits),
  );
  const [denyAbove, setDenyAbove] = useState(
    minorToMajor(policy.denyAboveMinorUnits),
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

      <label className="flex items-start gap-3 rounded-md border border-input p-3">
        <input
          type="checkbox"
          name="alwaysDeny"
          checked={alwaysDeny}
          onChange={(e) => setAlwaysDeny(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 rounded border-input text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        />
        <span className="grid gap-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Ban className="size-4 text-destructive" aria-hidden />
            Always deny refunds
          </span>
          <span className="text-xs text-muted-foreground">
            Block every refund regardless of amount. The agent never runs{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              refund.create
            </code>{" "}
            and falls back to drafting a reply. Thresholds below are ignored
            while this is on.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2 sm:max-w-lg">
        <div className="grid gap-2">
          <Label
            htmlFor="askAbove"
            className={cn(alwaysDeny && "text-muted-foreground")}
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
            disabled={alwaysDeny}
            required={!alwaysDeny}
            aria-describedby="ask-hint"
          />
          <p id="ask-hint" className="text-xs text-muted-foreground">
            Refunds at or below this amount auto-run.
          </p>
        </div>
        <div className="grid gap-2">
          <Label
            htmlFor="denyAbove"
            className={cn(alwaysDeny && "text-muted-foreground")}
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
            disabled={alwaysDeny}
            required={!alwaysDeny}
            aria-describedby="deny-hint"
          />
          <p id="deny-hint" className="text-xs text-muted-foreground">
            Hard cap. Refunds above this never run, even with approval.
          </p>
        </div>
      </div>

      {/* Disabled inputs don't post — mirror the retained thresholds so the
          server keeps them while the kill-switch is on. */}
      {alwaysDeny ? (
        <>
          <input type="hidden" name="askAbove" value={askAbove} />
          <input type="hidden" name="denyAbove" value={denyAbove} />
        </>
      ) : null}

      <Button type="submit">Save</Button>
    </form>
  );
};
