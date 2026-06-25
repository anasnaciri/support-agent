import { Banknote } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { refundCurrencyMismatch } from "@/lib/refund-currency";
import { resolveFeedback, type FeedbackRule } from "@/lib/toast-feedback";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { RefundPolicyForm } from "./refund-policy-form";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

const FEEDBACK: readonly FeedbackRule[] = [
  { param: "saved", kind: "success", message: "Refund policy saved." },
  {
    param: "error",
    match: "bad_currency",
    kind: "warning",
    message: "Currency must be a 3-letter ISO code (USD, EUR, GBP, …).",
  },
  {
    param: "error",
    match: "bad_amount",
    kind: "warning",
    message:
      "Both thresholds must be non-negative decimals with at most two digits after the decimal point.",
  },
  {
    param: "error",
    match: "bad_order",
    kind: "warning",
    message: "The ask threshold must not exceed the deny threshold.",
  },
];

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function RefundPolicyPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const [{ refundPolicy: policy }, shopCurrency] = await Promise.all([
    api.settings(ctx),
    // Best-effort — the warning is omitted if the store currency is unknown.
    api
      .shopCurrency(ctx)
      .catch(() => ({ currencyCode: null as string | null })),
  ]);
  const feedback = resolveFeedback((await searchParams) ?? {}, FEEDBACK);

  const showCurrencyWarning = refundCurrencyMismatch(
    policy.currencyCode,
    shopCurrency.currencyCode,
    policy.mode,
  );

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Refund policy" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Refund policy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set amount limits for refunds. Refunds at or below the{" "}
          <strong>ask threshold</strong> run automatically. Refunds between
          the two thresholds pause for your approval. Refunds above the{" "}
          <strong>deny threshold</strong> are blocked — the agent drafts a
          reply for you instead. Or skip the amounts entirely:{" "}
          <strong>always ask</strong> holds every refund for your approval,
          and <strong>always deny</strong> blocks them all.
        </p>
      </div>

      <FeedbackToaster toasts={feedback.toasts} consume={feedback.consume} />

      {showCurrencyWarning ? (
        <Alert variant="warning">
          <AlertDescription>
            Your Shopify store charges in{" "}
            <strong>{shopCurrency.currencyCode}</strong>, but this policy is set
            to <strong>{policy.currencyCode}</strong>. Refunds won&apos;t match
            your thresholds and will all pause for approval &mdash; set the
            currency to {shopCurrency.currencyCode} to fix this.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="size-4" aria-hidden />
            Thresholds
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <RefundPolicyForm policy={policy} />
        </CardContent>
      </Card>

      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">Current behaviour</p>
        {policy.mode === "always_deny" ? (
          <p>
            <strong className="text-foreground">Always deny is on.</strong> Every
            refund is blocked regardless of amount &mdash; the agent falls back
            to a drafted reply. The thresholds are ignored until you switch back
            to <em>Use thresholds</em>.
          </p>
        ) : policy.mode === "always_ask" ? (
          <p>
            <strong className="text-foreground">Always ask is on.</strong> Every
            refund waits for your approval regardless of amount &mdash; the
            agent drafts it and a human approves before it runs. The thresholds
            are ignored until you switch back to <em>Use thresholds</em>.
          </p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-foreground">Allow:</strong> 0 &ndash;{" "}
              {minorToMajor(policy.askAboveMinorUnits)} {policy.currencyCode}{" "}
              &mdash; auto-runs.
            </li>
            <li>
              <strong className="text-foreground">Ask:</strong>{" "}
              {minorToMajor(policy.askAboveMinorUnits)} &ndash;{" "}
              {minorToMajor(policy.denyAboveMinorUnits)} {policy.currencyCode}{" "}
              &mdash; pauses for approval.
            </li>
            <li>
              <strong className="text-foreground">Deny:</strong> &gt;{" "}
              {minorToMajor(policy.denyAboveMinorUnits)} {policy.currencyCode}{" "}
              &mdash; falls back to a drafted reply.
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
