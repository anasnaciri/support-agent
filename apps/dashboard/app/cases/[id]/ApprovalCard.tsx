import type { ApprovalDetail } from "@support-agent/dashboard-contracts";
import Link from "next/link";
import { ClipboardCheck, Lightbulb } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { riskVariant } from "@/lib/status-variants";

import { approveAction, rejectAction } from "../../approvals/[id]/actions";
import {
  RECOMMENDATION_LABEL,
  recommendationVariant,
  type RefundRecommendationSummary,
} from "./refund-recommendation";

interface Props {
  readonly approval: ApprovalDetail;
  readonly returnTo: string;
  /**
   * Latest `refund.recommend` tool output for this case, when present.
   * Surfaces the structured assessment above the editable reply body so
   * the operator sees what the agent thought before approving the prose.
   */
  readonly refundRecommendation?: RefundRecommendationSummary | null;
  /**
   * Damaged-product photo-vs-product cross-check verdict, stamped on the
   * case context by the damaged-product agent. Surfaced as a badge so
   * the operator's confidence is calibrated before they approve a
   * replacement/refund reply (a `mismatch` is a fraud signal worth a
   * second look).
   */
  readonly productMatch?: "match" | "mismatch" | "uncertain" | null;
  /**
   * EXIF rollup across the customer's photo attachments, stamped on the
   * case context by the runtime at upload time. A `stripped` image (no
   * camera metadata) is a cheap fraud signal — originals carry camera
   * EXIF; screenshots, AI-gen, and stock photos usually don't. Surfaced
   * as a chip; never auto-rejects.
   */
  readonly photoSignals?: {
    readonly count: number;
    readonly withExif: number;
    readonly stripped: number;
    readonly anyStripped: boolean;
  } | null;
  /**
   * Free-form risk flags stamped on the case context (e.g. the
   * duplicate-photo guard's `duplicate_photo_seen_in_case_<id>`). Surfaced
   * as destructive chips so the operator sees them before approving.
   */
  readonly riskFlags?: ReadonlyArray<string>;
}

const riskFlagLabel = (flag: string): string =>
  flag.startsWith("duplicate_photo_seen_in_case_")
    ? "Duplicate photo seen on another case"
    : flag;

const PRODUCT_MATCH_LABEL: Record<
  NonNullable<Props["productMatch"]>,
  string
> = {
  match: "Photos match ordered item",
  mismatch: "Photos may not match ordered item",
  uncertain: "Photo match uncertain",
};

const productMatchVariant = (
  m: NonNullable<Props["productMatch"]>,
): "success" | "destructive" | "outline" =>
  m === "match" ? "success" : m === "mismatch" ? "destructive" : "outline";

export const ApprovalCard = ({
  approval,
  returnTo,
  refundRecommendation,
  productMatch,
  photoSignals,
  riskFlags,
}: Props) => {
  const proposed =
    approval.proposedInput && typeof approval.proposedInput === "object"
      ? (approval.proposedInput as Record<string, unknown>)
      : null;
  const editableBodyText =
    proposed && typeof proposed["bodyText"] === "string"
      ? (proposed["bodyText"] as string)
      : null;

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
              <Badge variant="outline" className="font-mono text-xs">
                {approval.tool}
              </Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{approval.agentId}</span>
              <span>·</span>
              <Badge variant={riskVariant(approval.riskLevel)} className="px-1.5 py-0">
                risk: {approval.riskLevel}
              </Badge>
              <span>·</span>
              <span>{formatRelativeTime(approval.createdAt)}</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {approval.reasoning ? (
          <p className="text-sm">{approval.reasoning}</p>
        ) : null}

        {productMatch ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Photo check
            </span>
            <Badge variant={productMatchVariant(productMatch)} className="text-xs">
              {PRODUCT_MATCH_LABEL[productMatch]}
            </Badge>
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

        {editableBodyText !== null ? (
          <form action={approveAction} className="space-y-3">
            <input type="hidden" name="approvalId" value={approval.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="space-y-1.5">
              <Label
                htmlFor="bodyText"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Reply body (edit before approving)
              </Label>
              <Textarea
                id="bodyText"
                name="bodyText"
                defaultValue={editableBodyText}
                rows={6}
                className="bg-card"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="success">
                Approve &amp; send
              </Button>
              <Button asChild variant="outline">
                <Link href={`/approvals/${approval.id}`}>Open full view</Link>
              </Button>
            </div>
          </form>
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
            <form action={approveAction}>
              <input type="hidden" name="approvalId" value={approval.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="success">
                  Approve
                </Button>
                <Button asChild variant="outline">
                  <Link href={`/approvals/${approval.id}`}>Open full view</Link>
                </Button>
              </div>
            </form>
          </>
        )}

        <Separator className="bg-warning/30" />

        <form action={rejectAction}>
          <input type="hidden" name="approvalId" value={approval.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <Button type="submit" variant="destructive">
            Reject (escalate to human takeover)
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
