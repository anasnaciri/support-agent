// Pure, framework-free logic for the case-switcher sidebar. Kept out of the
// React component so the virtualization window math, infinite-scroll trigger,
// and page-merge dedup are unit-testable (mirrors settings-nav-items.ts).

/** Compact fixed row height, in px — uniform rows make windowing trivial. */
export const ROW_HEIGHT = 64;
/** Rows rendered above/below the viewport to hide scroll seams. */
export const OVERSCAN = 6;
/** Distance from the bottom (px) at which the next page is prefetched. */
export const LOAD_MORE_THRESHOLD_PX = 240;
/** Page size requested per fetch — must be one of the api's allowed sizes. */
export const SIDEBAR_PAGE_SIZE = 50;

/**
 * The case id for a `/cases/<id>` detail route (or any of its sub-routes),
 * or null for the bare list and every non-case route. Doubles as the
 * "show the cases sidebar" predicate (non-null ⇒ a case is open).
 */
export const caseIdFromPathname = (pathname: string): string | null => {
  const match = /^\/cases\/([^/]+)/.exec(pathname);
  return match ? (match[1] ?? null) : null;
};

export interface WindowRange {
  /** First row index to render (inclusive). */
  readonly start: number;
  /** One past the last row index to render (exclusive — slice-friendly). */
  readonly end: number;
  /** Spacer height before the first rendered row, in px. */
  readonly padTop: number;
  /** Full virtual height of all rows, in px. */
  readonly totalHeight: number;
}

/**
 * Which slice of a uniform-height list is visible (plus overscan) for a given
 * scroll offset. The component renders `rows.slice(start, end)` inside a
 * `totalHeight`-tall spacer, offset by `padTop`.
 */
export const windowRange = (
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): WindowRange => {
  const totalHeight = count * rowHeight;
  if (count === 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + overscan);
  return { start, end, padTop: start * rowHeight, totalHeight };
};

/**
 * Whether the next page should be prefetched: there's more to load, nothing is
 * already in flight, and the viewport's bottom edge is within `thresholdPx` of
 * the end of the loaded content.
 */
export const shouldLoadMore = (args: {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly totalHeight: number;
  readonly thresholdPx: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
}): boolean => {
  if (!args.hasMore || args.loading) return false;
  const bottomEdge = args.scrollTop + args.viewportHeight;
  return bottomEdge >= args.totalHeight - args.thresholdPx;
};

/**
 * Append a freshly fetched page to the loaded rows, dropping any whose id is
 * already present. Offset pagination over a list ordered by `updated_at` can
 * re-surface a row when a case updates mid-scroll; dedup keeps the UI stable.
 */
export const mergeDedupeById = <T extends { readonly id: string }>(
  existing: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const seen = new Set(existing.map((r) => r.id));
  const merged = [...existing];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
};

/**
 * Fold a freshly fetched page 1 into the already-loaded rows, updating
 * matching rows IN PLACE (same position) and ignoring rows that aren't
 * loaded. Used when the pathname changes (U8): the case the merchant just
 * took over / resumed gets its status badge updated without reordering the
 * list, resetting pagination, or jumping the scroll position.
 */
export const applyFreshPage = <T extends { readonly id: string }>(
  existing: ReadonlyArray<T>,
  fresh: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  if (fresh.length === 0) return existing;
  const byId = new Map(fresh.map((r) => [r.id, r]));
  return existing.map((row) => byId.get(row.id) ?? row);
};

// ── Sidebar mode: All vs Needs attention ────────────────────────────────────

/** "all" lists every case; "attention" hides resolved (done) cases. */
export type SidebarMode = "all" | "attention";

/** The terminal status hidden by the "Needs attention" mode. */
export const RESOLVED_STATUS = "resolved";

/** localStorage key remembering the merchant's chosen sidebar mode. */
export const MODE_STORAGE_KEY = "cases-sidebar-mode";

/** The statuses the api should exclude for a given mode. */
export const sidebarExcludeStatuses = (
  mode: SidebarMode,
): ReadonlyArray<string> =>
  mode === "attention" ? [RESOLVED_STATUS] : [];

/**
 * The stale-response / reset identity for a fetch. Folding the mode in (not
 * just the query text) means switching modes resets to page 1 and rejects any
 * in-flight response from the previous mode.
 */
export const sidebarRequestSignature = (
  mode: SidebarMode,
  q: string,
): string => `${mode} ${q}`;

/** A persisted mode value, defaulting to "all" for anything unrecognized. */
export const parseStoredMode = (raw: string | null): SidebarMode =>
  raw === "attention" ? "attention" : "all";

export interface CaseRowClasses {
  /** Classes for the row link container (background / elevation / opacity). */
  readonly container: string;
  /** Classes for the subject line (font weight / color). */
  readonly subject: string;
}

/**
 * Per-row appearance for the case switcher. The active row keeps its elevated,
 * medium-weight treatment regardless of status. Among inactive rows, resolved
 * (done) cases recede — lower opacity, thinner, muted — while everything still
 * needing work is bumped: semibold on a filled background.
 */
export const caseRowClasses = (args: {
  readonly status: string;
  readonly active: boolean;
}): CaseRowClasses => {
  if (args.active) {
    // Selected row: a bordered white card (no shadow — borders over shadows for
    // consistency with the rest of the case view).
    return {
      container: "border-primary bg-card",
      subject: "font-medium text-foreground",
    };
  }
  if (args.status === RESOLVED_STATUS) {
    return {
      container: "opacity-60 hover:bg-accent hover:opacity-100",
      subject: "font-light text-muted-foreground",
    };
  }
  return {
    container: "bg-muted/40 hover:bg-accent",
    subject: "font-semibold text-foreground",
  };
};
