/**
 * Operator-facing copy + defensive parsers for the structured return fields
 * (`case.context.returnReason` / `requestedResolution`) that refund-review-agent
 * stamps. The vocabularies mirror the closed literal unions in
 * `case.update_context`'s schema (packages/tools) — keep them in lockstep.
 */

export const RETURN_REASONS = [
  "defective",
  "wrong_item",
  "no_longer_needed",
  "arrived_late",
  "other",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const REQUESTED_RESOLUTIONS = [
  "refund",
  "replacement",
  "exchange",
  "store_credit",
  "repair",
] as const;
export type RequestedResolution = (typeof REQUESTED_RESOLUTIONS)[number];

const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  defective: "Defective",
  wrong_item: "Wrong item",
  no_longer_needed: "No longer needed",
  arrived_late: "Arrived late",
  other: "Other",
};

const REQUESTED_RESOLUTION_LABEL: Record<RequestedResolution, string> = {
  refund: "Refund",
  replacement: "Replacement",
  exchange: "Exchange",
  store_credit: "Store credit",
  repair: "Repair",
};

export const returnReasonLabel = (r: ReturnReason): string =>
  RETURN_REASON_LABEL[r];

export const requestedResolutionLabel = (r: RequestedResolution): string =>
  REQUESTED_RESOLUTION_LABEL[r];

export const parseReturnReason = (v: unknown): ReturnReason | null =>
  typeof v === "string" && (RETURN_REASONS as readonly string[]).includes(v)
    ? (v as ReturnReason)
    : null;

export const parseRequestedResolution = (
  v: unknown,
): RequestedResolution | null =>
  typeof v === "string" &&
  (REQUESTED_RESOLUTIONS as readonly string[]).includes(v)
    ? (v as RequestedResolution)
    : null;
