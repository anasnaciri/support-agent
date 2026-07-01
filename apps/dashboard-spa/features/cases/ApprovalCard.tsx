import { useState } from "react";
import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import { ClipboardCheck, Clock, Lightbulb } from "lucide-react";

import { api } from "@/lib/api-client";
import { useApprovalDecision } from "@/lib/use-case-mutation";
import { formatRelativeTime } from "@/lib/format";
import { toolActionLabel } from "@/lib/labels";
import { riskVariant } from "@/lib/status-variants";
import { draftStaleness } from "@/lib/draft-staleness";
import {
  RECOMMENDATION_LABEL,
  recommendationVariant,
  type RefundRecommendationSummary,
} from "@/lib/refund-recommendation";
import { riskFlagLabel } from "@/lib/risk-flag-label";
import {
  requestedResolutionLabel,
  returnReasonLabel,
  type RequestedResolution,
  type ReturnReason,
} from "@/lib/return-labels";
import { Link } from "@/components/ui/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ConfirmButton } from "./ConfirmButton";

interface Props {
  readonly workspaceId: string;
  readonly caseId: string;
  readonly approval: ApprovalDetail;
  readonly refundRecommendation?: RefundRecommendationSummary | null;
  readonly productMatch?: "match" | "mismatch" | "uncertain" | null;
  readonly photoSignals?: {
    readonly count: number;
    readonly withExif: number;
    readonly stripped: number;
    readonly anyStripped: boolean;
  } | null;
  readonly riskFlags?: ReadonlyArray<string>;
  readonly returnReason?: ReturnReason | null;
  readonly requestedResolution?: RequestedResolution | null;
}

const PRODUCT_MATCH_LABEL: Record<"match" | "mismatch" | "uncertain", string> = {
  match: "Photos match ordered item",
  mismatch: "Photos may not match ordered item",
  uncertain: "Photo match uncertain",
};

const productMatchVariant = (
  m: "match" | "mismatch" | "uncertain",
): "success" | "destructive" | "outline" =>
  m === "match" ? "success" : m === "mismatch" ? "destructive" : "outline";

export function ApprovalCard({
  workspaceId,
  caseId,
  approval,
  refundRecommendation,
  productMatch,
  photoSignals,
  riskFlags,
  returnReason,
  requestedResolution,
}: Props) {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  const editableInitial =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;
  const [bodyText, setBodyText] = useState(editableInitial ?? "");
  const staleness = draftStaleness(approval.createdAt);

  const approveM = useApprovalDecision({
    workspaceId,
    caseId,
    action: "approve",
    mutationFn: () =>
      api.approveApproval(
        { workspaceId },
        approval.id,
        editableInitial !== null && proposed
          ? { ...proposed, bodyText }
          : undefined,
      ),
  });
  const rejectM = useApprovalDecision({
    workspaceId,
    caseId,
    action: "reject",
    mutationFn: () => api.rejectApproval({ workspaceId }, approval.id),
  });

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ClipboardCheck className="size-4 text-warning" />
              <span className="text-base font-semibold text-warning">
                Awaiting approval
              </span>
              <Badge variant="outline" className="text-xs">
                {toolActionLabel(approval.tool)}
              </Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{approval.agentId}</span>
              <span>·</span>
              <Badge
                variant={riskVariant(approval.riskLevel)}
                className="px-1.5 py-0"
              >
                Risk: {approval.riskLevel}
              </Badge>
              <span>·</span>
              <span>{formatRelativeTime(approval.createdAt)}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {staleness ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <Clock className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p>
              Drafted {staleness.ageLabel} ago — the order, policy, or
              conversation may have changed since. Review before sending.
            </p>
          </div>
        ) : null}

        {approval.reasoning ? (
          <p className="text-sm">{approval.reasoning}</p>
        ) : null}

        {productMatch ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Photo check
            </span>
            <Badge
              variant={productMatchVariant(productMatch)}
              className="text-xs"
            >
              {PRODUCT_MATCH_LABEL[productMatch]}
            </Badge>
          </div>
        ) : null}

        {returnReason || requestedResolution ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Return
            </span>
            {requestedResolution ? (
              <Badge variant="outline" className="text-xs">
                Wants: {requestedResolutionLabel(requestedResolution)}
              </Badge>
            ) : null}
            {returnReason ? (
              <Badge variant="outline" className="text-xs">
                Reason: {returnReasonLabel(returnReason)}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {photoSignals ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Photo EXIF
            </span>
            <Badge
              variant={photoSignals.anyStripped ? "destructive" : "success"}
              className="text-xs"
            >
              {photoSignals.anyStripped
                ? photoSignals.withExif > 0
                  ? `${photoSignals.stripped} of ${photoSignals.count} stripped`
                  : "Camera metadata stripped"
                : "Camera metadata present"}
            </Badge>
          </div>
        ) : null}

        {riskFlags && riskFlags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Risk flags
            </span>
            {riskFlags.map((flag) => (
              <Badge key={flag} variant="destructive" className="text-xs">
                {riskFlagLabel(flag)}
              </Badge>
            ))}
          </div>
        ) : null}

        {refundRecommendation ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <Lightbulb className="size-4 text-primary" aria-hidden />
              <span className="font-medium">Agent recommendation</span>
              <Badge
                variant={recommendationVariant(
                  refundRecommendation.recommendation,
                )}
                className="text-xs"
              >
                {RECOMMENDATION_LABEL[refundRecommendation.recommendation]}
              </Badge>
              {refundRecommendation.amount ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {refundRecommendation.amount.amount}{" "}
                  {refundRecommendation.amount.currencyCode}
                </span>
              ) : null}
            </div>
            {refundRecommendation.reasoning ? (
              <p className="text-muted-foreground">
                {refundRecommendation.reasoning}
              </p>
            ) : null}
            {refundRecommendation.riskFlags.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {refundRecommendation.riskFlags.map((f) => (
                  <Badge
                    key={f}
                    variant="outline"
                    className="font-mono text-[10px] uppercase tracking-wider"
                  >
                    {f}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {editableInitial !== null ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="bodyText"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Reply body (edit before approving)
              </Label>
              <Textarea
                id="bodyText"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={6}
                className="bg-card"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => approveM.mutate()}
                disabled={approveM.isPending}
              >
                Approve &amp; send
              </Button>
              <Button asChild variant="outline">
                <Link href={`/approvals/${approval.id}`}>Open full view</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Proposed input
              </summary>
              <pre className="mt-2 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                {JSON.stringify(approval.proposedInput, null, 2)}
              </pre>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => approveM.mutate()}
                disabled={approveM.isPending}
              >
                Approve
              </Button>
              <Button asChild variant="outline">
                <Link href={`/approvals/${approval.id}`}>Open full view</Link>
              </Button>
            </div>
          </>
        )}

        <Separator className="bg-warning/30" />

        <ConfirmButton
          title="Reject this approval?"
          description="No customer reply goes out, and the case escalates to human takeover — you'll handle it manually from there."
          confirmLabel="Reject & take over"
          pending={rejectM.isPending}
          onConfirm={() => rejectM.mutate()}
        >
          Reject (escalate to human takeover)
        </ConfirmButton>
      </CardContent>
    </Card>
  );
}
