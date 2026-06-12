/**
 * Map a raw `case.context.riskFlags` entry to operator-facing copy. The flags
 * are stamped by the runtime's fraud / prompt-injection guards; unknown flags
 * fall through to their raw string so a newly-added guard still renders
 * something rather than nothing.
 */
export const riskFlagLabel = (flag: string): string => {
  if (flag.startsWith("duplicate_photo_seen_in_case_")) {
    return "Duplicate photo seen on another case";
  }
  if (flag === "refund_customer_mismatch") {
    return "Refund order belongs to a different customer";
  }
  return flag;
};
