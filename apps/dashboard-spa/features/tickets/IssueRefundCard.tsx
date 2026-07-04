import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import {
  RECOMMENDATION_LABEL,
  recommendationVariant,
  type RefundRecommendationSummary,
} from "@/lib/refund-recommendation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmButton } from "./ConfirmButton";

// The agent RECOMMENDED a refund (PATH B — read-only), so there's no approval to
// approve; issuing it here runs the equivalent of refund.create under the
// operator's authority (gated on refunds.issue). The recommended amount/currency
// are issued as-is; the header RefundDialog is the richer line-item path.
export function IssueRefundCard({
  workspaceId,
  ticketId,
  refund,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly refund: RefundRecommendationSummary & {
    readonly amount: { readonly amount: string; readonly currencyCode: string };
  };
}) {
  const issueM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "issueRefund",
    mutationFn: () =>
      api.issueRefund({ workspaceId }, ticketId, {
        amount: refund.amount.amount,
        currencyCode: refund.amount.currencyCode,
      }),
  });

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="space-y-2 px-4 py-4 2xl:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Agent recommended a refund</span>
          <Badge
            variant={recommendationVariant(refund.recommendation)}
            className="text-xs"
          >
            {RECOMMENDATION_LABEL[refund.recommendation]}
          </Badge>
          <span className="font-mono text-sm">
            {refund.amount.amount} {refund.amount.currencyCode}
          </span>
        </div>
        {refund.reasoning ? (
          <p className="text-sm text-muted-foreground">{refund.reasoning}</p>
        ) : null}
        <ConfirmButton
          variant="default"
          title="Issue this refund?"
          description={`This moves real money: ${refund.amount.amount} ${refund.amount.currencyCode} is refunded to the customer's original payment method and Shopify emails them the confirmation. This can't be undone from here.`}
          confirmLabel="Issue refund"
          pending={issueM.isPending}
          onConfirm={() => issueM.mutate()}
        >
          Issue refund
        </ConfirmButton>
      </CardContent>
    </Card>
  );
}
