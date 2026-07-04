// Pure failure-streak logic for the live-updates poller (U11). Framework-free
// so it's unit-testable; TicketLiveBoundary.tsx is thin glue around it.

/**
 * Consecutive poll failures before the boundary surfaces visible
 * "Updates paused" text (instead of only the amber dot). At a 2.5s poll
 * interval this is ~7.5s of outage — long enough to skip transient blips.
 */
export const PAUSE_AFTER_FAILURES = 3;

/** Advance the consecutive-failure streak: reset on success, +1 on failure. */
export const nextFailureCount = (prev: number, ok: boolean): number =>
  ok ? 0 : prev + 1;

/** Whether the streak warrants the visible "Updates paused" treatment. */
export const isPaused = (failures: number): boolean =>
  failures >= PAUSE_AFTER_FAILURES;
