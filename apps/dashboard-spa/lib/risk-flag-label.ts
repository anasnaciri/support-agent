import { humanizeSlug } from "./labels";

/** Prefix the runtime stamps per matching ticket: one flag per prior ticket the
 *  same photo turned up on (`duplicate_photo_seen_in_ticket_<ticketId>`). */
const DUPLICATE_PHOTO_PREFIX = "duplicate_photo_seen_in_ticket_";

/**
 * Map a raw `ticket.context.riskFlags` entry to operator-facing copy. The flags
 * are stamped by the runtime's fraud / prompt-injection guards; unknown flags
 * are humanized so a newly-added guard still renders words, not snake_case.
 */
export const riskFlagLabel = (flag: string): string => {
  if (flag.startsWith(DUPLICATE_PHOTO_PREFIX)) {
    return "Duplicate photo seen on another ticket";
  }
  if (flag === "refund_customer_mismatch") {
    return "Refund order belongs to a different customer";
  }
  if (flag === "order_customer_mismatch") {
    return "Order belongs to a different customer: identity unverified";
  }
  if (flag === "tracking_destination_mismatch") {
    return "Tracking may belong to a different order";
  }
  if (flag === "reply_delivery_failed") {
    return "Reply didn't send: delivery failed";
  }
  if (flag === "supplier_unreachable") {
    return "Supplier could not be reached";
  }
  return humanizeSlug(flag);
};

/** One rendered risk-flag chip. `ticketIds`, when present, are the other tickets
 *  the duplicate-photo guard matched — the UI links them (inline for one, in a
 *  hover tooltip for many). */
export interface RiskFlagBadge {
  readonly text: string;
  readonly ticketIds?: ReadonlyArray<string>;
}

/**
 * Collapse a ticket's raw `riskFlags` into rendered chips. Every
 * `duplicate_photo_seen_in_ticket_<id>` flag names a different prior ticket the
 * same photo appeared on; showing one chip per hit floods the card with
 * identical pills, so they merge into a single chip that counts the matches and
 * carries their ids for linking. The merged chip keeps the slot of its first
 * flag; all other flags map 1:1 through {@link riskFlagLabel}.
 *
 * Duplicate entries collapse: the same ticket id (a chip aggregates DISTINCT
 * tickets) and repeated non-photo flags are each shown once — some persisted
 * arrays carry duplicates a value-rename or pre-dedup write left behind.
 */
export const buildRiskFlagBadges = (
  flags: ReadonlyArray<string>,
): RiskFlagBadge[] => {
  const badges: RiskFlagBadge[] = [];
  const ticketIds: string[] = [];
  const seenTicketIds = new Set<string>();
  const seenFlags = new Set<string>();
  let dupSlot = -1;
  for (const flag of flags) {
    if (flag.startsWith(DUPLICATE_PHOTO_PREFIX)) {
      const id = flag.slice(DUPLICATE_PHOTO_PREFIX.length).trim();
      if (id && !seenTicketIds.has(id)) {
        seenTicketIds.add(id);
        ticketIds.push(id);
      }
      if (dupSlot === -1) {
        dupSlot = badges.length;
        badges.push({ text: "" }); // placeholder; filled once the count is known
      }
      continue;
    }
    if (seenFlags.has(flag)) continue;
    seenFlags.add(flag);
    badges.push({ text: riskFlagLabel(flag) });
  }
  if (dupSlot !== -1) {
    const n = ticketIds.length;
    badges[dupSlot] =
      n === 0
        ? { text: "Duplicate photo seen on another ticket" }
        : {
            text:
              n === 1
                ? "Duplicate photo seen on ticket"
                : `Duplicate photo seen in ${n} tickets`,
            ticketIds,
          };
  }
  return badges;
};

/**
 * Self-contained chip text for a merged risk-flag badge — for compact surfaces
 * (the approval signal strip / card) that can't render the context card's
 * inline ticket links. A duplicate-photo chip names its DISTINCT ticket count;
 * every other flag uses its own label.
 */
export const riskFlagChipText = (badge: RiskFlagBadge): string => {
  const n = badge.ticketIds?.length ?? 0;
  if (n === 0) return badge.text;
  return `Duplicate photo seen on ${n} ticket${n === 1 ? "" : "s"}`;
};
