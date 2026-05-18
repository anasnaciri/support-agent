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

export const formatRelativeTime = (
  date: Date,
  now: Date = new Date(),
): string => {
  const ms = now.getTime() - date.getTime();
  if (ms < 0) return "just now"; // clock skew safety
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  // For older entries the exact date is more useful than weeks ago.
  return date.toISOString().slice(0, 10);
};
