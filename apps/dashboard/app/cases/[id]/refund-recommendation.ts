export interface RefundRecommendationSummary {
  readonly recommendation:
    | "full_refund"
    | "partial_refund"
    | "deny"
    | "investigate";
  readonly amount: { readonly amount: string; readonly currencyCode: string } | null;
  readonly reasoning: string;
  readonly riskFlags: ReadonlyArray<string>;
}

// Only the fields this module reads — so the api's AuditEntry (string id +
// ISO occurredAt) is assignable without coupling to the DB row type.
export interface RecommendationAuditEntry {
  readonly action: string;
  readonly details: unknown;
}

const detailRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

export const refundRecommendationFromEntry = (
  entry: RecommendationAuditEntry,
): RefundRecommendationSummary | null => {
  if (entry.action !== "tool.invoked") return null;
  const details = detailRecord(entry.details);
  if (!details || details["tool"] !== "refund.recommend") return null;
  const output = detailRecord(details["output"]);
  if (!output) return null;
  const rec = output["recommendation"];
  if (
    rec !== "full_refund" &&
    rec !== "partial_refund" &&
    rec !== "deny" &&
    rec !== "investigate"
  ) {
    return null;
  }
  const reasoning =
    typeof output["reasoning"] === "string"
      ? (output["reasoning"] as string)
      : "";
  const flagsRaw = output["riskFlags"];
  const riskFlags = Array.isArray(flagsRaw)
    ? flagsRaw.filter((f): f is string => typeof f === "string")
    : [];
  const amountRaw = detailRecord(output["amount"]);
  const amount =
    amountRaw &&
    typeof amountRaw["amount"] === "string" &&
    typeof amountRaw["currencyCode"] === "string"
      ? {
          amount: amountRaw["amount"] as string,
          currencyCode: amountRaw["currencyCode"] as string,
        }
      : null;
  return { recommendation: rec, amount, reasoning, riskFlags };
};

/**
 * Walk newest -> oldest so re-runs surface the latest recommendation.
 */
export const extractRefundRecommendation = (
  entries: ReadonlyArray<RecommendationAuditEntry>,
): RefundRecommendationSummary | null => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const summary = refundRecommendationFromEntry(entries[i]!);
    if (summary) return summary;
  }
  return null;
};

export const RECOMMENDATION_LABEL: Readonly<
  Record<RefundRecommendationSummary["recommendation"], string>
> = {
  full_refund: "Full refund",
  partial_refund: "Partial refund",
  deny: "Deny",
  investigate: "Investigate",
};

export const recommendationVariant = (
  r: RefundRecommendationSummary["recommendation"],
): "success" | "warning" | "destructive" | "outline" => {
  if (r === "full_refund") return "success";
  if (r === "partial_refund") return "outline";
  if (r === "investigate") return "warning";
  return "destructive";
};
