import { humanizeSlug } from "./labels";

/**
 * Map a raw `ticket.context.riskFlags` entry to operator-facing copy. The flags
 * are stamped by the runtime's fraud / prompt-injection guards; unknown flags
 * are humanized so a newly-added guard still renders words, not snake_case.
 */
export const riskFlagLabel = (flag: string): string => {
  if (flag.startsWith("duplicate_photo_seen_in_ticket_")) {
    return "Duplicate photo seen on another ticket";
  }
  if (flag === "refund_customer_mismatch") {
    return "Refund order belongs to a different customer";
  }
  if (flag === "order_customer_mismatch") {
    return "Order belongs to a different customer — identity unverified";
  }
  if (flag === "reply_delivery_failed") {
    return "Reply didn't send — delivery failed";
  }
  if (flag === "supplier_unreachable") {
    return "Supplier could not be reached";
  }
  return humanizeSlug(flag);
};
