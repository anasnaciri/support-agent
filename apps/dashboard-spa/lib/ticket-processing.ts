// The statuses where the agent is actively working the ticket *right now* —
// not parked, not waiting on anyone, not terminal. Drives the ticket page's
// live-activity affordances: the composer's animated border and the status
// chip's shimmer. `new` is excluded: the ticket exists but nothing has picked
// it up yet. Unknown statuses fail safe to "not processing" (no animation).
const PROCESSING_STATUSES: ReadonlySet<string> = new Set([
  "triaging",
  "in_progress",
  "approved_action_running",
]);

export const isTicketProcessing = (status: string): boolean =>
  PROCESSING_STATUSES.has(status);
