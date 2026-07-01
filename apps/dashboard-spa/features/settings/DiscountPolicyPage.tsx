import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, HandCoins, SlidersHorizontal, TicketPercent } from "lucide-react";

import type {
  DiscountPolicyMode,
  DiscountPolicyView,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { cn } from "@/lib/utils";
import {
  parseValidityDays,
  resolveDiscountThresholds,
} from "@/lib/parse-discount";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

// The Next page drove feedback through post-redirect-get + a FEEDBACK rule
// array; the SPA fires the same copy directly from the mutation callbacks and
// from client-side validation that mirrors the server action's guards.
const SAVED_MESSAGE = "Discount policy saved.";
const BAD_CURRENCY_MESSAGE =
  "Currency must be a 3-letter ISO code (USD, EUR, GBP, …).";
const BAD_VALIDITY_MESSAGE =
  "The expiry window must be a whole number of days between 1 and 365.";
const RESOLUTION_ERROR_MESSAGE: Record<
  "bad_percentage" | "bad_amount" | "bad_order",
  string
> = {
  bad_percentage:
    "Percentages must be between 0 and 100 with at most two decimals.",
  bad_amount:
    "Fixed amounts must be non-negative decimals with at most two digits after the decimal point.",
  bad_order: "The auto limit must not exceed the block limit.",
};

// Client component because the mode selector toggles the threshold inputs
// between active and disabled in the browser. Every field is controlled, so
// switching to always-ask / always-deny and saving still preserves the
// merchant's thresholds for when they switch back.
const DiscountPolicyForm = ({ policy }: { policy: DiscountPolicyView }) => {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  const [mode, setMode] = useState<DiscountPolicyMode>(policy.mode);
  const [currencyCode, setCurrencyCode] = useState(policy.currencyCode);
  const [validityDays, setValidityDays] = useState(String(policy.maxValidityDays));
  const [askPct, setAskPct] = useState(String(policy.askAbovePercentage));
  const [maxPct, setMaxPct] = useState(String(policy.maxPercentage));
  const [askAmt, setAskAmt] = useState(
    minorToMajor(policy.askAboveFixedAmountMinorUnits),
  );
  const [maxAmt, setMaxAmt] = useState(
    minorToMajor(policy.maxFixedAmountMinorUnits),
  );

  const saveM = useMutation({
    mutationFn: (input: {
      readonly currencyCode: string;
      readonly askAbovePercentage: number;
      readonly maxPercentage: number;
      readonly askAboveFixedAmountMinorUnits: number;
      readonly maxFixedAmountMinorUnits: number;
      readonly maxValidityDays: number;
      readonly mode: DiscountPolicyMode;
    }) => api.setDiscountPolicy(ctx, input),
    onSuccess: () => {
      toast.success(SAVED_MESSAGE);
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const thresholdsActive = mode === "thresholds";

  const optionClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
      selected ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
    );

  const muted = (active: boolean) => cn(!active && "text-muted-foreground");

  const onSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();

    // Validation the action did BEFORE persisting — mirror it client-side and
    // toast the same warning, preserving the entered values.
    const currency = currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      toast.warning(BAD_CURRENCY_MESSAGE);
      return;
    }

    const days = parseValidityDays(validityDays);
    if (days === null) {
      toast.warning(BAD_VALIDITY_MESSAGE);
      return;
    }

    // Dormant thresholds fall back PER FIELD to the stored value so a stale tab
    // can't silently zero saved numbers (same U10 guard as refunds).
    const resolved = resolveDiscountThresholds({
      mode,
      askPctRaw: askPct,
      maxPctRaw: maxPct,
      askAmtRaw: askAmt,
      maxAmtRaw: maxAmt,
      stored: {
        askPct: policy.askAbovePercentage,
        maxPct: policy.maxPercentage,
        askMinor: policy.askAboveFixedAmountMinorUnits,
        maxMinor: policy.maxFixedAmountMinorUnits,
      },
    });
    if (!resolved.ok) {
      toast.warning(RESOLUTION_ERROR_MESSAGE[resolved.error]);
      return;
    }

    saveM.mutate({
      currencyCode: currency,
      askAbovePercentage: resolved.askPct,
      maxPercentage: resolved.maxPct,
      askAboveFixedAmountMinorUnits: resolved.askMinor,
      maxFixedAmountMinorUnits: resolved.maxMinor,
      maxValidityDays: days,
      mode,
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
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
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
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
            value={validityDays}
            onChange={(e) => setValidityDays(e.target.value)}
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
                <Label
                  htmlFor="askAbovePercentage"
                  className={muted(thresholdsActive)}
                >
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
                <Label
                  htmlFor="maxPercentage"
                  className={muted(thresholdsActive)}
                >
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
                <Label
                  htmlFor="askAboveFixedAmount"
                  className={muted(thresholdsActive)}
                >
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
                <Label
                  htmlFor="maxFixedAmount"
                  className={muted(thresholdsActive)}
                >
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

      <Button type="submit" disabled={saveM.isPending}>
        {saveM.isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
};

export function DiscountPolicyPage() {
  const ctx = useWorkspaceCtx();
  const allowed = useRequirePermission("settings.refund_policy");
  const { data, isLoading } = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const policy = data?.discountPolicy;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Discount policy" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Discount policy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Limits for the goodwill coupon codes the agent can issue. Every coupon
          is <strong>single-use</strong>, <strong>locked to the customer</strong>{" "}
          on the order, and not combinable with other discounts — you only
          control the value limits here. Coupons at or below the{" "}
          <strong>auto</strong> limit issue automatically; between the limits
          they pause for your approval; above the <strong>block</strong> limit
          the agent drafts a reply instead. Or <strong>always ask</strong> /{" "}
          <strong>always deny</strong> to skip the limits.
        </p>
      </div>

      {isLoading || !policy ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <TicketPercent className="size-4" aria-hidden />
                Limits
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <DiscountPolicyForm policy={policy} />
            </CardContent>
          </Card>

          <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">Current behaviour</p>
            {policy.mode === "always_deny" ? (
              <p>
                <strong className="text-foreground">Always deny is on.</strong>{" "}
                The agent never issues a coupon — it drafts a reply instead. The
                limits are ignored until you switch back to{" "}
                <em>Use thresholds</em>.
              </p>
            ) : policy.mode === "always_ask" ? (
              <p>
                <strong className="text-foreground">Always ask is on.</strong>{" "}
                Every coupon waits for your approval regardless of value. The
                limits are ignored until you switch back to{" "}
                <em>Use thresholds</em>.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-foreground">Auto-issue:</strong> up to{" "}
                  {policy.askAbovePercentage}% or {policy.currencyCode}{" "}
                  {minorToMajor(policy.askAboveFixedAmountMinorUnits)}.
                </li>
                <li>
                  <strong className="text-foreground">Ask:</strong> between the
                  auto and block limits — pauses for approval.
                </li>
                <li>
                  <strong className="text-foreground">Block:</strong> above{" "}
                  {policy.maxPercentage}% or {policy.currencyCode}{" "}
                  {minorToMajor(policy.maxFixedAmountMinorUnits)} — falls back to
                  a drafted reply.
                </li>
                <li>
                  <strong className="text-foreground">Expiry:</strong> every
                  coupon expires {policy.maxValidityDays} days after issue.
                </li>
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
