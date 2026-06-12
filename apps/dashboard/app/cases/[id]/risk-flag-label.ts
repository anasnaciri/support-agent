import { humanizeSlug } from "../../../lib/labels";

/**
 * Map a raw `case.context.riskFlags` entry to operator-facing copy. The flags
 * are stamped by the runtime's fraud / prompt-injection guards; unknown flags
 * are humanized so a newly-added guard still renders words, not snake_case.
 */
export const riskFlagLabel = (flag: string): string => {
  if (flag.startsWith("duplicate_photo_seen_in_case_")) {
    return "Duplicate photo seen on another case";
  }
  if (flag === "refund_customer_mismatch") {
    return "Refund order belongs to a different customer";
  }
  return humanizeSlug(flag);
};
