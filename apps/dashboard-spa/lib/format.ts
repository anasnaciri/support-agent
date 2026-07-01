// Time formatting helpers used by Server Components.
//
// `formatRelativeTime` returns a coarse "Xh ago" / "Xd ago" — the
// dashboard's Today view + lists need recognisable age at a glance,
// not exact precision. For exact timestamps the case detail page
// shows the ISO string. We keep precision coarse on purpose: an SSE
// refresh can re-render a list with a string like "just now" → "2m ago"
// in 2 minutes, and we don't want the page to feel unstable.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Coerce a value that the domain types as `Date` but the JSON wire delivers
 * as an ISO string. The dashboard reads through apps/api (Path B) and
 * `JSON.parse` has no Date type, so any `Date`-typed field is actually a
 * string at runtime — calling `.getTime()` / `.toISOString()` on it throws.
 * Render code coerces with this first.
 */
export const asDate = (date: Date | string): Date =>
  typeof date === "string" ? new Date(date) : date;

export const formatRelativeTime = (
  date: Date | string,
  now: Date = new Date(),
): string => {
  // The api returns ISO strings; Server Components used to pass Date objects.
  // Accept both so call sites don't each have to wrap in `new Date(...)`.
  const d = asDate(date);
  const ms = now.getTime() - d.getTime();
  if (ms < 0) return "just now"; // clock skew safety
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  // For older entries the exact date is more useful than weeks ago.
  return d.toISOString().slice(0, 10);
};
