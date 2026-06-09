import { Banknote } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { RefundPolicyForm } from "./refund-policy-form";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function RefundPolicyPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const { refundPolicy: policy } = await api.settings(ctx);
  const params = (await searchParams) ?? {};

  const savedBanner =
    (Array.isArray(params["saved"]) ? params["saved"][0] : params["saved"]) ===
    "1";
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Refund policy" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Refund policy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-tenant amount thresholds for the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            refund.create
          </code>{" "}
          tool. Refunds at or below the <strong>ask threshold</strong> auto-run.
          Refunds between the two thresholds pause for human approval. Refunds
          above the <strong>deny threshold</strong> are blocked and the agent
          falls back to drafting a reply. Or skip the amounts entirely:{" "}
          <strong>always ask</strong> holds every refund for approval, and{" "}
          <strong>always deny</strong> blocks them all.
        </p>
      </div>

      {savedBanner ? (
        <Alert variant="success">
          <AlertDescription>Refund policy saved.</AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "bad_currency" ? (
        <Alert variant="warning">
          <AlertDescription>
            Currency must be a 3-letter ISO code (USD, EUR, GBP, …).
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "bad_amount" ? (
        <Alert variant="warning">
          <AlertDescription>
            Both thresholds must be non-negative decimals with at most two
            digits after the decimal point.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "bad_order" ? (
        <Alert variant="warning">
          <AlertDescription>
            The ask threshold must not exceed the deny threshold.
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
