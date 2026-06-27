import { asDate } from "./format";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A draft older than this earns a non-blocking "review before sending" nudge.
 * Mirrors the old 24h approval-expiry window: approvals no longer expire by
 * age (a manager can approve a week-old draft), so this banner is the only
 * staleness signal the operator gets — the order, policy, or conversation may
 * have moved on since the agent drafted the action.
 */
export const DRAFT_STALE_AFTER_MS = DAY_MS;

export interface DraftStaleness {
  /** Coarse human age, e.g. "1 day", "5 days". */
  readonly ageLabel: string;
}

/**
 * Whether an approval draft is old enough to warrant a staleness nudge, plus a
 * coarse age label. Returns null for fresh drafts (< {@link DRAFT_STALE_AFTER_MS})
 * and for unparseable timestamps. `createdAt` may be an ISO string (Path B
 * delivers Date fields as JSON strings) or a Date.
 */
export const draftStaleness = (
  createdAt: Date | string,
  now: Date = new Date(),
): DraftStaleness | null => {
  const ms = now.getTime() - asDate(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < DRAFT_STALE_AFTER_MS) return null;
  const days = Math.floor(ms / DAY_MS);
  return { ageLabel: days === 1 ? "1 day" : `${days} days` };
};
