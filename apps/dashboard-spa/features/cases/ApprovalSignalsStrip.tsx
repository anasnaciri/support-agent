import {
  RECOMMENDATION_LABEL,
  recommendationVariant,
  type RefundRecommendationSummary,
} from "@/lib/refund-recommendation";
import {
  requestedResolutionLabel,
  returnReasonLabel,
  type RequestedResolution,
  type ReturnReason,
} from "@/lib/return-labels";
import { riskFlagLabel } from "@/lib/risk-flag-label";
import { Link } from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";

const PRODUCT_MATCH_LABEL: Record<"match" | "mismatch" | "uncertain", string> = {
  match: "Photos match item",
  mismatch: "Photos may not match item",
  uncertain: "Photo match uncertain",
};

// A compact read-only signal strip above the approval-mode composer: the agent's
// recommendation, photo-match verdict, requested resolution / return reason, and
// any risk flags — so the operator's confidence is calibrated before approving.
export function ApprovalSignalsStrip({
  approvalId,
  recommendation,
  productMatch,
  riskFlags,
  returnReason,
  requestedResolution,
}: {
  readonly approvalId: string;
  readonly recommendation: RefundRecommendationSummary | null;
  readonly productMatch: "match" | "mismatch" | "uncertain" | null;
  readonly riskFlags: ReadonlyArray<string>;
  readonly returnReason: ReturnReason | null;
  readonly requestedResolution: RequestedResolution | null;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-warning">
        Awaiting your approval
      </span>
      {recommendation ? (
        <Badge
          variant={recommendationVariant(recommendation.recommendation)}
          className="text-xs"
        >
          {RECOMMENDATION_LABEL[recommendation.recommendation]}
          {recommendation.amount
            ? ` · ${recommendation.amount.amount} ${recommendation.amount.currencyCode}`
            : ""}
        </Badge>
      ) : null}
      {productMatch ? (
        <Badge
          variant={
            productMatch === "match"
              ? "success"
              : productMatch === "mismatch"
                ? "destructive"
                : "outline"
          }
          className="text-xs"
        >
          {PRODUCT_MATCH_LABEL[productMatch]}
        </Badge>
      ) : null}
      {requestedResolution ? (
        <Badge variant="outline" className="text-xs">
          Wants: {requestedResolutionLabel(requestedResolution)}
        </Badge>
      ) : null}
      {returnReason ? (
        <Badge variant="outline" className="text-xs">
          {returnReasonLabel(returnReason)}
        </Badge>
      ) : null}
      {riskFlags.map((flag) => (
        <Badge key={flag} variant="destructive" className="text-xs">
          {riskFlagLabel(flag)}
        </Badge>
      ))}
      <Link
        href={`/approvals/${approvalId}`}
        className="text-xs text-primary hover:underline"
      >
        Full review
      </Link>
    </div>
  );
}
