// Pure width math for the resizable secondary sidebar. Kept framework-free so
// the clamp + cookie-parse are unit-tested; AppShell owns the drag interaction
// and the server layout owns reading the persisted cookie.

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 256;

/** Clamp a candidate width to the allowed range, rounded to a whole pixel. */
export const clampSidebarWidth = (px: number): number =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)));

/** Resolve the persisted `sidebar:width` cookie to a usable width. */
export const parseSidebarWidth = (cookieValue: string | undefined): number => {
  const n = Number(cookieValue);
  if (!Number.isFinite(n) || n <= 0) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(n);
};
