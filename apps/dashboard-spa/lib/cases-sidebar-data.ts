// Pure, framework-free logic for the case-switcher sidebar. Kept out of the
// React component so the virtualization window math, infinite-scroll trigger,
// and page-merge dedup are unit-testable (mirrors settings-nav-items.ts).

/** Fixed row height, in px — uniform rows make windowing trivial. Tall enough
 *  for the avatar + name/time, subject, preview, and status/order meta line. */
export const ROW_HEIGHT = 96;
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

/** The terminal statuses hidden by the "Needs attention" mode. */
export const RESOLVED_STATUS = "resolved";
export const ARCHIVED_STATUS = "archived";

/** localStorage key remembering the merchant's chosen sidebar mode. */
export const MODE_STORAGE_KEY = "cases-sidebar-mode";

/** The statuses the api should exclude for a given mode. */
export const sidebarExcludeStatuses = (
  mode: SidebarMode,
): ReadonlyArray<string> =>
  mode === "attention" ? [RESOLVED_STATUS, ARCHIVED_STATUS] : [];

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

// ── Row display helpers (avatar / name / priority / order ref) ──────────────

/** Up to two initials from a name or email; "?" when there's nothing to show. */
export const initialsFrom = (source: string | null | undefined): string => {
  const words = (source ?? "").trim().split(/[\s@._-]+/).filter(Boolean);
  const letters =
    (words[0]?.[0] ?? "") + (words.length > 1 ? (words[1]![0] ?? "") : "");
  return letters.toUpperCase() || "?";
};

/**
 * A friendly display name derived from an email's local part
 * (`"jane.lin@shop.com"` → `"Jane Lin"`). Best-effort — role addresses read a
 * little oddly (`"orders@…"` → `"Orders"`) but it's closer to the reference's
 * customer-name row than a raw address. Null when there's no email.
 */
export const displayNameFromEmail = (
  email: string | null | undefined,
): string | null => {
  const local = (email ?? "").split("@")[0] ?? "";
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

/** Whether a case's priority should surface the PRIORITY tag. */
export const isPriorityCase = (
  priority: string | null | undefined,
): boolean =>
  typeof priority === "string" && priority.length > 0 && priority !== "normal";

/**
 * A compact, customer-facing order ref for a row: a human order name like
 * `"#1001"` is shown as-is; a `gid://shopify/Order/123` or a bare numeric id
 * collapses to `"#123"`; null when there's no order.
 */
export const formatOrderRef = (
  raw: string | null | undefined,
): string | null => {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s.startsWith("#")) return s;
  const gid = /\/Order\/(\d+)/.exec(s);
  if (gid) return `#${gid[1]}`;
  if (/^\d+$/.test(s)) return `#${s}`;
  return s;
};

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
  if (args.status === RESOLVED_STATUS || args.status === ARCHIVED_STATUS) {
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
