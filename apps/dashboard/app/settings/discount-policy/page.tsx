import { TicketPercent } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { resolveFeedback, type FeedbackRule } from "@/lib/toast-feedback";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { DiscountPolicyForm } from "./discount-policy-form";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

const FEEDBACK: readonly FeedbackRule[] = [
  { param: "saved", kind: "success", message: "Discount policy saved." },
  {
    param: "error",
    match: "bad_currency",
    kind: "warning",
    message: "Currency must be a 3-letter ISO code (USD, EUR, GBP, …).",
  },
  {
    param: "error",
    match: "bad_percentage",
    kind: "warning",
    message:
      "Percentages must be between 0 and 100 with at most two decimals.",
  },
  {
    param: "error",
    match: "bad_amount",
    kind: "warning",
    message:
      "Fixed amounts must be non-negative decimals with at most two digits after the decimal point.",
  },
  {
    param: "error",
    match: "bad_validity",
    kind: "warning",
    message:
      "The expiry window must be a whole number of days between 1 and 365.",
  },
  {
    param: "error",
    match: "bad_order",
    kind: "warning",
    message: "The auto limit must not exceed the block limit.",
  },
];

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function DiscountPolicyPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const { discountPolicy: policy } = await api.settings(ctx);
  const feedback = resolveFeedback((await searchParams) ?? {}, FEEDBACK);

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

      <FeedbackToaster toasts={feedback.toasts} consume={feedback.consume} />

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
            <strong className="text-foreground">Always deny is on.</strong> The
            agent never issues a coupon — it drafts a reply instead. The limits
            are ignored until you switch back to <em>Use thresholds</em>.
          </p>
        ) : policy.mode === "always_ask" ? (
          <p>
            <strong className="text-foreground">Always ask is on.</strong> Every
            coupon waits for your approval regardless of value. The limits are
            ignored until you switch back to <em>Use thresholds</em>.
          </p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-foreground">Auto-issue:</strong> up to{" "}
              {policy.askAbovePercentage}% or {policy.currencyCode}{" "}
              {minorToMajor(policy.askAboveFixedAmountMinorUnits)}.
            </li>
            <li>
              <strong className="text-foreground">Ask:</strong> between the auto
              and block limits — pauses for approval.
            </li>
            <li>
              <strong className="text-foreground">Block:</strong> above{" "}
              {policy.maxPercentage}% or {policy.currencyCode}{" "}
              {minorToMajor(policy.maxFixedAmountMinorUnits)} — falls back to a
              drafted reply.
            </li>
            <li>
              <strong className="text-foreground">Expiry:</strong> every coupon
              expires {policy.maxValidityDays} days after issue.
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
